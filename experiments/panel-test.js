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
for (const [column, first, second] of [['left', 'selection-menu', 'sysmenu'], ['left', 'sysmenu', 'routemenu'], ['inner', 'viewmenu', 'trade-menu'], ['right', 'menu', 'help']]) {
	const start = html.indexOf('panel-column-' + column);
	assert.ok(start >= 0 && html.indexOf('id="' + first + '"', start) < html.indexOf('id="' + second + '"', start));
	checks++;
}
// ui.20: the panels hide through `hidden` (workspace.js's applyPanels is the
// one writer), so the stylesheet must make `hidden` win over `.panel`'s
// display and the columns must know all seven panels.
assert.ok(/\.panel\[hidden\]\s*\{\s*display:\s*none\s*!important;/.test(fs.readFileSync('src/style.css', 'utf8')));
checks++;
const css = fs.readFileSync('src/style.css', 'utf8');
assert.ok(css.includes('position: static;') && css.includes('flex: none;'));
assert.ok(css.includes('#trade-calendar, #trade-log {\n\theight: 112px;'));
assert.ok(css.includes('#trade-list, #colonisation-list, #route-list {\n\theight: 96px;'));
console.log(`${checks + 3} panel checks passed`);
