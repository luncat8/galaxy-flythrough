// Panel wiring runs without WebGPU; exercise the actual main.js functions.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const main = fs.readFileSync('src/main.js', 'utf8');
const source = main.slice(main.indexOf('        function toggleCollapse'), main.indexOf('        wireCollapse(menu,'));
let checks = 0;
for (const initial of [null, 'false', 'true', 'invalid', 'denied']) {
	const values = new Map([['galaxy.panel.menu.collapsed', initial]]);
	let collapsed = false;
	const panel = {
		id: 'menu',
		classList: { toggle(name, force) { collapsed = force === undefined ? !collapsed : force; return collapsed; } },
		querySelector() { return { addEventListener() {} }; },
	};
	const button = { addEventListener() {}, setAttribute(name, value) { this[name] = value; } };
	const context = {
		localStorage: {
			getItem(key) { if (initial === 'denied') throw Error('denied'); return values.get(key); },
			setItem(key, value) { if (initial === 'denied') throw Error('denied'); values.set(key, value); },
		},
		releasePanelInput() {}, canvas: { focus() {} },
	};
	vm.createContext(context);
	vm.runInContext(source, context);
	context.wireCollapse(panel, button);
	assert.strictEqual(collapsed, initial === 'true');
	assert.strictEqual(button['aria-expanded'], String(!collapsed));
	context.toggleCollapse(panel, button);
	assert.strictEqual(collapsed, initial !== 'true');
	assert.strictEqual(button['aria-expanded'], String(!collapsed));
	if (initial !== 'denied') assert.strictEqual(values.get('galaxy.panel.menu.collapsed'), String(collapsed));
	checks++;
}
const html = fs.readFileSync('src/index.html', 'utf8');
assert.ok(html.includes('id="btn-find-earthlike"'));
assert.ok(main.includes("tokenBox.value = 'state:ms|terran'"));
assert.ok(main.indexOf('tradeLib.reseedIfEmpty(tradeNet') < main.indexOf('const skyGated = tradeNet.skyState'));
// trade.28: the empty network's task row at the top of the Trade panel. Its
// two presses are the Search panel's search and the Colonisation row's
// founding, and the line's writer is the module's own status.
assert.ok(html.includes('id="trade-search-home"') && html.includes('id="trade-found-here"')
	&& html.includes('id="trade-bootstrap-note"'));
// The row is not conditional on an empty network (trade.28a: the user never saw
// it, because a present-day boot always has its seed colonies); only the reason
// line is, and it starts hidden.
assert.ok(!/id="trade-bootstrap"[^>]*hidden/.test(html));
assert.ok(/id="trade-bootstrap-note"[^>]*hidden/.test(html));
assert.ok(main.includes('tradeBootstrapNote.hidden = !empty'));
assert.ok(main.includes('tradeSearchHome.addEventListener(\'click\', findEarthlike)'));
assert.ok(main.includes('tradeFoundHere.addEventListener(\'click\', commandFoundColony)'));
assert.ok(main.includes('tradeLib.bootstrapStatus(tradeNet, model, renderer.fieldBuffers())'));
assert.ok(main.includes('syncTradeBootstrap(true)') && main.includes('syncTradeBootstrap(false)'));
assert.ok(main.includes('tradeLib.refInSky(ref, model, tradeCtx.field, starTimeRate)'));
assert.ok(/id="trade-action-note"[^>]*hidden/.test(html));
assert.ok(main.includes('function canCommandTrade() { return !isFlying(); }'));
// The inspector belongs by the clock at the top, before the colony list,
// so a full world's explanation is visible without scrolling to the logs.
assert.ok(html.indexOf('id="trade-rate"') < html.indexOf('id="trade-colony-card"')
	&& html.indexOf('id="trade-colony-card"') < html.indexOf('id="trade-list"'));
assert.ok(html.includes('id="trade-colony-detail"')
	&& main.includes('syncTradeColonyDetail(inspected, rateY)'));
checks++;

// trade.31: exercise the real main.js founding & notice slice in Observe,
// Command, and Fly — covering empty-network "Search for a home -> select planet
// -> Establish here" as well as visible refusal feedback outside Fly.
{
	const Workspace = require('../src/core/workspace.js');
	const SelectionStore = require('../src/core/selection-store.js');
	const GalaxyLib = require('../src/math/galaxy.js');
	const PlanetsLib = require('../src/math/planets.js');
	const Landmarks = require('../src/data/landmarks.js');
	const EconomyLib = require('../src/core/economy.js');
	const TradeLib = require('../src/core/trade.js');

	const fnSlices = [
		main.slice(main.indexOf('        function syncTradeActionNote()'), main.indexOf('        // The reason codes ship.js keeps')),
		main.slice(main.indexOf('        function commandFoundColony()'), main.indexOf('        function gameTradePort()')),
		main.slice(main.indexOf('        const COLONY_BAR ='), main.indexOf('        function tradeLogText(')),
		main.slice(main.indexOf('        function tradeRowText('), main.indexOf('        function tradeSyncPortRows(')),
		main.slice(main.indexOf('        function syncTradeBootstrap(noNetwork)'), main.indexOf('        function syncTradeUi()')),
		main.slice(main.indexOf('        function modeHudLine()'), main.indexOf('        function tradeOverlayLine()')),
	].join('\n');

	const model = GalaxyLib.MILKY_WAY;
	const store = SelectionStore.createSelectionStore();
	const tradeRecord = PlanetsLib.createSystemRecord();
	const tradeCtx = { model, field: { count: 0 }, member: null, name: '' };

	// Find a landmark with a habitable planet and (if present) a poor-habitat planet.
	let goodLandmark = -1, goodPlanet = -1, poorLandmark = -1, poorPlanet = -1;
	const site = EconomyLib.createSite();
	for (let i = 0; i < Landmarks.ENTRIES.length; i++) {
		const e = Landmarks.ENTRIES[i];
		const ref = {
			kind: PlanetsLib.BLOCK_LANDMARK, index: i, key: PlanetsLib.landmarkKey(i) >>> 0,
			x: e.x, y: e.y, z: e.z, colorIndex: e.colorIndex, absMag: e.absMag,
		};
		tradeCtx.name = e.name;
		PlanetsLib.generateSystem(ref, tradeCtx, tradeRecord);
		const seed = EconomyLib.siteSeed(ref.key, model.seed, ref.kind);
		for (let p = 0; p < tradeRecord.counts.planets; p++) {
			EconomyLib.fillPlanetSite(site, ref, tradeRecord, p, seed);
			const h = TradeLib.siteHabitatScore(site);
			if (goodLandmark < 0 && h >= TradeLib.MIN_CANDIDATE_HABITAT) {
				goodLandmark = i; goodPlanet = p;
			}
			if (poorLandmark < 0 && h < TradeLib.MIN_CANDIDATE_HABITAT) {
				poorLandmark = i; poorPlanet = p;
			}
		}
		if (goodLandmark >= 0 && poorLandmark >= 0) break;
	}
	assert.ok(goodLandmark >= 0 && poorLandmark >= 0, 'found both habitable and barren test planets');

	const makeRef = (idx) => {
		const e = Landmarks.ENTRIES[idx];
		return {
			kind: PlanetsLib.BLOCK_LANDMARK, index: idx, key: PlanetsLib.landmarkKey(idx) >>> 0,
			x: e.x, y: e.y, z: e.z, colorIndex: e.colorIndex, absMag: e.absMag,
		};
	};

	for (const mode of [Workspace.OBSERVE, Workspace.COMMAND]) {
		const net = TradeLib.createNetwork({ seed: model.seed, modelSeed: model.seed, seedPorts: 0 });
		TradeLib.finalize(net);
		let ws = mode;
		let openSys = true;
		let selKind = 1; // BODY_PLANET
		let selIdx = goodPlanet;
		let pickedRef = makeRef(goodLandmark);
		const tradeFoundHere = { disabled: true };
		const tradeBootstrapNote = { hidden: true, textContent: '' };
		const tradeActionNote = { hidden: true, textContent: '' };
		const tradeColonyCard = { hidden: true, dataset: {} };
		const tradeColonyTitle = { textContent: '' };
		const tradeColonySource = { textContent: '' };
		const tradeColonyDetail = { textContent: '' };
		const ctx = {
			Workspace,
			window: {
				PlanetsLib,
				SystemLayer: { BODY_NONE: 0, BODY_PLANET: 1, BODY_BELT: 2, BODY_STAR: 3 },
				SelectionStore,
			},
			tradeLib: TradeLib,
			economyLib: EconomyLib,
			tradeNet: net,
			tradeCtx,
			tradeRecord,
			model,
			starTimeRate: 0,
			NOTICE_TICKS: 12,
			autoMsg: '',
			autoMsgTicks: 0,
			starSet: { primary: 0 },
			selectionStore: store,
			tradeFoundHere,
			tradeBootstrapNote,
			tradeActionNote,
			tradeColonyCard, tradeColonyTitle, tradeColonySource, tradeColonyDetail,
			renderer: {
				state: {},
				fieldBuffers: () => ({ count: 0 }),
				starBlocks: () => ({ member: null }),
			},
			camera: { getState: () => ({}) },
			statsText: {},
			systemLayer: {
				isOpen: () => openSys,
				selectedKindOf: () => selKind,
				selectedIndexOf: () => selIdx,
			},
			isFlying: () => ws === Workspace.FLY,
			isCommanding: () => ws === Workspace.COMMAND,
			canCommandTrade: () => ws !== Workspace.FLY,
			tradeClockRate: () => 100,
			tradeSyncNote: () => '',
			homeColonyPort: () => net.capital,
			memberRefFor: () => pickedRef,
			landmarkNameFor: () => Landmarks.ENTRIES[pickedRef.index].name,
			syncSelectionPanel() {},
			syncTradeUi() { ctx.syncTradeBootstrap(false); },
			syncFlightUi() {},
			writeSystemReadout() {},
			updateOverlay() {},
		};
		vm.createContext(ctx);
		vm.runInContext(fnSlices, ctx);

		ctx.syncTradeBootstrap(false);
		assert.strictEqual(tradeFoundHere.disabled, false, 'Establish here enabled when star picked in mode ' + mode);
		assert.strictEqual(tradeBootstrapNote.hidden, false, 'empty network shows bootstrap note before founding');

		// 1) Barren planet refusal is surfaced visibly in both #trade-action-note and HUD.
		pickedRef = makeRef(poorLandmark);
		selIdx = poorPlanet;
		ctx.commandFoundColony();
		assert.strictEqual(net.portCount, 0);
		assert.strictEqual(tradeActionNote.hidden, false);
		assert.ok(tradeActionNote.textContent.includes('no site worth settling'));
		assert.ok(ctx.modeHudLine().includes('notice    no site worth settling'));

		// 2) Habitable planet succeeds (both with V open and with V closed via stored planet selection).
		pickedRef = makeRef(goodLandmark);
		selIdx = goodPlanet;
		if (mode === Workspace.OBSERVE) {
			openSys = false;
			store.selectCurrent(SelectionStore.GROUP_SPACE, {
				type: 'planet', id: pickedRef.key + ':planet:' + goodPlanet, name: 'planet',
				x: pickedRef.x, y: pickedRef.y, z: pickedRef.z,
				entity: { host: { key: pickedRef.key }, bodyKind: 1, index: goodPlanet },
			});
		}
		ctx.commandFoundColony();
		assert.strictEqual(net.portCount, 1, 'colony founded in mode ' + mode);
		assert.strictEqual(net.capital, 0, 'first colony becomes capital');
		assert.strictEqual(net.shipCount, 1, 'starter ship spawned on first colony');
		assert.strictEqual(tradeBootstrapNote.hidden, true, 'empty-network note hides once colony exists');
		assert.strictEqual(tradeActionNote.hidden, false);
		assert.ok(tradeActionNote.textContent.includes('colony founded at'));

		// 3) In Fly mode, free-camera founding is refused with an explicit notice.
		ws = Workspace.FLY;
		ctx.syncTradeBootstrap(false);
		assert.strictEqual(tradeFoundHere.disabled, true);
		ctx.commandFoundColony();
		assert.ok(tradeActionNote.textContent.includes('dock at a star to found while flying'));

		// 4) trade.32: multi-world port row badge and LOG_SIBLING log formatting.
		const extraSite = EconomyLib.createSite();
		extraSite.key = net.ports[0].key;
		extraSite.kind = 1;
		extraSite.index = 0;
		extraSite.isBelt = 1;
		extraSite.type = EconomyLib.SITE_BELT;
		extraSite.name = 'Home belt 1';
		TradeLib.addWorld(net, 0, extraSite, 0, TradeLib.FRESH_FOUND);
		TradeLib.pushLog(net, TradeLib.LOG_SIBLING, 0, 1, 0);
		const rowText = ctx.tradeRowText(0, -1);
		const logEntry = TradeLib.logAt(net, TradeLib.logLength(net) - 1);
		const logText = ctx.tradeLogEntryText(logEntry);
		assert.ok(rowText.includes('\u00b7 2w'), 'multi-world port row carries 2w badge: ' + rowText);
		assert.ok(logText.startsWith('settled    Home belt 1 in '), 'LOG_SIBLING formatted cleanly: ' + logText);
		checks++;

		// The GUI reports *net* natural change, not the supply-only potential:
		// two full but supplied worlds used to read ↑0.7%/y indefinitely.
		const home = TradeLib.worldOfPort(net, 0, 0);
		const belt = TradeLib.worldOfPort(net, 0, 1);
		for (const world of [home, belt]) {
			world.pop = world.capacity;
			world.stock.fill(0);
			for (let r = 0; r < EconomyLib.RESOURCE_COUNT; r++) {
				world.outBase[r] = EconomyLib.NEED[r] * 0.46;
			}
			EconomyLib.refreshColonyHealth(world);
		}
		TradeLib.foldPort(net, 0);
		let info = ctx.colonyDevelopment(0, 100, {});
		assert.strictEqual(info.rate, 0);
		assert.ok(info.potential > 0.006 && info.potential < 0.008);
		assert.ok(info.text.includes('→ 0%/y (0 people/y)')
			&& info.text.includes('Supply      +0.70%/y potential')
			&& info.text.includes('2/2 worlds at capacity')
			&& info.shortages.includes('volatiles') && info.shortages.includes('food & seed'));
		assert.ok(ctx.tradeRowText(0, -1).includes('→0%/y · cap'), 'row no longer advertises 0.7% growth at K');
		checks++;

		// Rounding the list's M display cannot conceal a small *nonzero* change:
		// the card shows exact people and the row says <0.001% rather than 0.0%.
		const oldRounded = EconomyLib.formatPop(home.pop);
		home.pop -= 1e-5;
		EconomyLib.refreshColonyHealth(home);
		TradeLib.foldPort(net, 0);
		info = ctx.colonyDevelopment(0, 100, {});
		assert.strictEqual(EconomyLib.formatPop(home.pop), oldRounded);
		assert.ok(info.rate > 0 && info.rate < 0.00001
			&& info.text.includes('<0.001%/y') && info.text.includes('+<1 person/y')
			&& ctx.tradeRowText(0, -1).includes('↑<0.001%/y'));
		assert.ok(ctx.colonyDevelopment(0, 0, {}).text.includes('paused — no trade years pass'));
		checks++;

		for (const world of [home, belt]) {
			world.pop = world.capacity / 2;
			world.stock.fill(0);
			world.outBase.fill(0);
			EconomyLib.refreshColonyHealth(world);
		}
		TradeLib.foldPort(net, 0);
		info = ctx.colonyDevelopment(0, 100, {});
		assert.ok(info.rate < 0 && info.reason.includes('below 25% break-even')
			&& info.shortages.includes('0% met') && !info.shortages.includes('ore')
			&& ctx.tradeRowText(0, -1).includes('↓'));
		checks++;

		// The actual card writer follows the open star, and a vanished colony
		// cannot leave its last readout on screen.
		ctx.starSet.primary = -1;
		openSys = false;
		assert.strictEqual(ctx.inspectedTradePort(), 0, 'without a selection, inspect the capital');
		ctx.syncTradeColonyDetail(0, 100);
		assert.ok(tradeColonySource.textContent.startsWith('capital · '));
		ctx.starSet.keys = [net.ports[0].key];
		ctx.systemLayer.record = { star: { key: net.ports[0].key } };
		openSys = true;
		assert.strictEqual(ctx.inspectedTradePort(), 0);
		ctx.syncTradeColonyDetail(0, 100);
		assert.strictEqual(tradeColonyCard.hidden, false);
		assert.ok(tradeColonySource.textContent.startsWith('selected · ')
			&& tradeColonySource.textContent.includes(net.ports[0].name));
		assert.strictEqual(tradeColonyTitle.textContent, 'Colony development');
		assert.ok(tradeColonyDetail.textContent.includes('Population')
			&& tradeColonyDetail.textContent.includes('Short'));
		ctx.syncTradeColonyDetail(-1, 0);
		assert.strictEqual(tradeColonyCard.hidden, false);
		assert.ok(tradeColonyDetail.textContent.includes('No visible colony')
			&& tradeColonyCard.dataset.health === 'paused');
		for (const world of [home, belt]) EconomyLib.demoteColony(world, 200);
		TradeLib.foldPort(net, 0);
		ctx.syncTradeColonyDetail(0, 100);
		assert.ok(tradeColonyDetail.textContent.includes('frozen')
			&& tradeColonyCard.dataset.health === 'outpost');
		ctx.tradeNet = null;
		ctx.syncTradeColonyDetail(-1, 0);
		assert.strictEqual(tradeColonyCard.hidden, true);
		checks++;
	}
	assert.ok(main.includes('tradeLib.siblingReadoutText(tradeNet, portIndex)'));
	assert.ok(main.includes('` (${tradeNet.worldCount} worlds)`'));
	checks++;
}

for (const [column, first, second] of [['left', 'selection-menu', 'sysmenu'], ['left', 'sysmenu', 'routemenu'], ['inner', 'viewmenu', 'trade-menu'], ['inner', 'trade-menu', 'time-menu'], ['right', 'scenario-menu', 'menu'], ['right', 'menu', 'help']]) {
	const start = html.indexOf('panel-column-' + column);
	assert.ok(start >= 0 && html.indexOf('id="' + first + '"', start) < html.indexOf('id="' + second + '"', start));
	checks++;
}
// ui.20/u.21: the panels hide through `hidden` (workspace.js's applyPanels is
// the one writer), so the stylesheet must make `hidden` win over `.panel`'s
// display and the columns must know every panel — including the formation
// checks, which sit in the right column above Display.
assert.ok(/\.panel\[hidden\]\s*\{\s*display:\s*none\s*!important;/.test(fs.readFileSync('src/style.css', 'utf8')));
checks++;
const css = fs.readFileSync('src/style.css', 'utf8');
assert.ok(css.includes('position: static;') && css.includes('flex: none;'));
// The panel has its own block, and the column rule (which turns a fixed panel
// into a flex child) names it — otherwise it would float above the column.
assert.ok(/#scenario-menu\s*\{/.test(css));
checks++;
assert.ok(css.split('\n').some((line) => line.indexOf('.panel-column > :is(') === 0
	&& line.includes('#scenario-menu')));
checks++;
// The clock board (time-plan §1) is a panel of the inner column like the rest:
// its own block, named by the column rule so it never floats over the trade
// panel, and a ledger row for every clock it prints.
assert.ok(/#time-menu\s*\{/.test(css) && css.includes('.time-ledger') && css.includes('.time-row'));
checks++;
assert.ok(css.split('\n').some((line) => line.indexOf('.panel-column > :is(') === 0
	&& line.includes('#time-menu')));
checks++;
const timeMenu = html.slice(html.indexOf('id="time-menu"'), html.indexOf('id="scenario-menu"'));
assert.ok(/id="time-star"/.test(timeMenu) && /id="time-trade"/.test(timeMenu)
	&& /id="time-system"/.test(timeMenu) && /id="time-ship"/.test(timeMenu)
	&& /id="time-epoch"/.test(timeMenu) && /id="time-trade-sync"/.test(timeMenu)
	&& /id="time-system-sync"/.test(timeMenu), 'the board prints five clocks and two links');
checks++;
for (const id of ['linked', 'trade', 'planetary']) {
	assert.ok(timeMenu.includes('data-time-mode="' + id + '"'), 'the board offers the ' + id + ' progression');
	checks++;
}
// The retired star-moving progression is gone from the panel, not only from
// the table (trade.36: time is time, game progression is game progression).
assert.ok(!timeMenu.includes('data-time-mode="generation"')
	&& !/id="trade-generation-ships"/.test(html), 'no progression offers a generation toggle');
checks++;
assert.ok(css.includes('#trade-calendar, #trade-log {\n\theight: 112px;'));
assert.ok(css.includes('#trade-list, #colonisation-list, #route-list {\n\theight: 96px;'));
console.log(`${checks + 3} panel checks passed`);
