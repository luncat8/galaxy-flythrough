// experiments/selection-store-test.js
// Typed history and search-result state for the separate Search & Selection panel.

'use strict';

const assert = require('assert/strict');
const SelectionStore = require('../src/core/selection-store.js');

const { GROUP_SPACE, GROUP_ASSET, SPACE_TYPES, ASSET_TYPES } = SelectionStore;
const store = SelectionStore.createSelectionStore();

assert.deepEqual(SPACE_TYPES, ['star', 'planet', 'other']);
assert.deepEqual(ASSET_TYPES, ['ship', 'base', 'colony', 'dock-port', 'cargo-container', 'other']);
assert.equal(store.natural.current, null);
assert.equal(store.assets.previous, null);

const star1 = {
	group: GROUP_SPACE, type: 'star', key: 101, name: 'Star One', kind: 0, index: 1,
	x: 1, y: 2, z: 3, colorIndex: 4, absMag: 5,
	mass: 1.1, lum: 0.8, teff: 5400, rStar: 0.9, age: 4, metal: 0.01,
};
const star2 = {
	group: GROUP_SPACE, type: 'star', key: 202, name: 'Star Two', kind: 0, index: 2,
	x: 4, y: 5, z: 6, colorIndex: 5, absMag: 6,
	mass: 0.7, lum: 0.3, teff: 4100, rStar: 0.7, age: 7, metal: -0.1,
};

store.selectCurrent(GROUP_SPACE, star1);
star1.x = 999;
assert.equal(store.natural.current.x, 1, 'the history owns a snapshot, not the caller object');
store.selectCurrent(GROUP_SPACE, star2);
assert.equal(store.natural.previous.key, 101);
assert.equal(store.natural.current.key, 202);
store.selectCurrent(GROUP_SPACE, Object.assign({}, star2, { x: 4.5 }));
assert.equal(store.natural.previous.key, 101, 'refreshing the same identity does not advance history');
assert.equal(store.natural.current.x, 4.5, 'refreshing the current identity updates its snapshot');
assert.equal(store.swap(GROUP_SPACE).key, 101);
assert.equal(store.natural.previous.key, 202);

const ship = { type: 'ship', id: 'ship-17', name: 'Wayfarer' };
const base = { type: 'base', id: 'base-3', name: 'Outpost' };
store.selectCurrent(GROUP_ASSET, ship);
store.selectCurrent(GROUP_ASSET, base);
assert.equal(store.assets.previous.type, 'ship');
assert.equal(store.assets.current.type, 'base');
assert.equal(store.natural.current.key, 101, 'asset history is independent of natural history');
assert.equal(store.swap(GROUP_ASSET).type, 'ship');
assert.equal(store.assets.previous.type, 'base');

store.setAssetPair(store.assets.current, { type: 'dock-port', id: 'port-2', name: 'North Dock' });
assert.equal(store.assetPair.length, 2);
assert.equal(store.assetPair[0].type, 'ship');
assert.equal(store.assetPair[1].type, 'dock-port');
assert.notEqual(store.assetPair[0], store.assets.current, 'the pair stores its own typed snapshot');
assert.equal(store.setAssetPair({ type: 'not-an-asset' }, ship)[0], null);

const resultRows = [Object.assign({}, star2, { group: GROUP_SPACE })];
store.setSearchResults(GROUP_SPACE, resultRows);
assert.equal(store.natural.searchResults[0].key, 202);
store.setSearchResults(GROUP_ASSET, [ship]);
assert.equal(store.natural.searchResults.length, 1, 'only group 1a owns searchable natural-object results');
assert.equal(store.selectCurrent('missing', star1), false);
assert.equal(store.selectCurrent(GROUP_SPACE, { type: 'ship', id: 'wrong-group' }), false);

store.clearHistory(GROUP_SPACE);
assert.equal(store.natural.current, null);
assert.equal(store.natural.searchResults.length, 1, 'clearing history does not silently erase search results');
store.clear();
assert.equal(store.natural.searchResults.length, 0);
assert.equal(store.assets.current, null);
assert.deepEqual(store.assetPair, [null, null]);

console.log('PASS — typed selection histories, swap, results, and two-slot asset pair');
