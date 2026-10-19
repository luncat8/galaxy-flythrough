// Preloaded by `scripts/run.py quick|changed` (node --require): a partial run
// must not rewrite experiments/logs/. `GALAXY_LOG_WRITES=off` tells
// `log-file.js` to keep its hands off too (and to say so), while the stub
// below covers the few logs written directly (PNG frames, PPM traces).
'use strict';

const fs = require('fs');
const path = require('path');

process.env.GALAXY_LOG_WRITES = 'off';

const LOG_DIR = path.join(__dirname, 'logs') + path.sep;
const realWrite = fs.writeFileSync;

fs.writeFileSync = function (target, ...rest) {
	if (typeof target === 'string' && path.resolve(target).startsWith(LOG_DIR)) return undefined;
	return realWrite.call(this, target, ...rest);
};
