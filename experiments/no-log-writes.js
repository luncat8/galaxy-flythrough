// Preloaded by `scripts/run.py quick|changed` (node --require): drops writes
// under experiments/logs/ so a partial run does not dirty the tree with
// timestamps and timings. Tests stay unchanged and keep writing their logs
// when run alone or by `all-tests`.
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs') + path.sep;
const realWrite = fs.writeFileSync;

fs.writeFileSync = function (target, ...rest) {
	if (typeof target === 'string' && path.resolve(target).startsWith(LOG_DIR)) return undefined;
	return realWrite.call(this, target, ...rest);
};
