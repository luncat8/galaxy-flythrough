// experiments/log-file.js
//
// One writer for every `experiments/logs/*.json`. Re-running a test whose code
// did not change produces the same payload except for its `date`; rewriting the
// file for that alone turns every test run into repository noise. `writeLog`
// compares against what is already on disk (JSON, key order included, since the
// same code builds the same object) and keeps the old file — timestamp and all —
// when the only difference is the top-level `date`. A changed check, a new
// field or a fresh timing still writes.
//
// `scripts/run.py quick|changed` preloads `no-log-writes.js`, which sets
// GALAXY_LOG_WRITES=off: a partial run writes nothing at all (and says so).

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_INDENT = 2;

function display(filePath) {
	const rel = path.relative(process.cwd(), filePath);
	return rel.startsWith('..') ? filePath : rel;
}

// Only the top level: a nested `date` is test data, not the log's timestamp.
function withoutDate(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
	const { date, ...rest } = value;
	return rest;
}

function differsOnlyInDate(next, previousText) {
	if (typeof previousText !== 'string') return false;
	let previous;
	try { previous = JSON.parse(previousText); } catch (err) { return false; }
	return JSON.stringify(withoutDate(next)) === JSON.stringify(withoutDate(previous));
}

function writeLog(filePath, value, options) {
	const indent = options && options.indent !== undefined ? options.indent : DEFAULT_INDENT;
	if (process.env.GALAXY_LOG_WRITES === 'off') {
		console.log(`Kept ${display(filePath)} (partial run: no log writes)`);
		return false;
	}
	const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
	if (differsOnlyInDate(value, previous)) {
		console.log(`Kept ${display(filePath)} (unchanged except date)`);
		return false;
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, indent) + '\n');
	console.log(`Wrote ${display(filePath)}`);
	return true;
}

const LogFile = { writeLog };

if (typeof module !== 'undefined') module.exports = LogFile;
