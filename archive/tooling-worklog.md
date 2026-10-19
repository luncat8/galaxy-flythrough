# Tooling worklog

Development tooling: the test runner, the log writer, asset generators and the
checks that keep the tree honest. Unversioned like `ui.x` — it can land beside
or between model releases.

## tooling.1 — logs stop rewriting themselves for a new timestamp

**Decision.** Every experiment ended with the same four lines: `mkdirSync` plus
`writeFileSync(path, JSON.stringify({ date: new Date().toISOString(), ... }))`.
`all-tests` therefore rewrote ~30 logs on every run even when no measured value
had moved, and a clean tree was dirty afterwards. A timestamp is the one field
that always differs; it is not a result. The write is now one call,
`logFile.writeLog(path, payload, { indent })`:

- `experiments/log-file.js` parses the file already on disk, strips the
  top-level `date` from both payloads and keeps the old file — untouched, old
  timestamp and all — when the rest of the JSON matches. A changed check, a new
  field, a timing or a nested `date` still writes. A file that does not parse is
  replaced. Indent is an argument (`2` default, `'\t'` for `route.json`, `1` for
  `galaxy-evolution.json`, `0` for the compact `galaxy-sample.json`), so a
  formatting difference is not mistaken for content.
- All 44 log writers were converted (the four-line tail collapsed into one
  call), the now-unused `fs`/`mkdirSync` imports and lines dropped, and the
  per-test `Wrote ...` lines retired: the writer prints `Wrote <rel>` or
  `Kept <rel> (unchanged except date)` itself. `route-test.js` gained the
  `path` import it needed to stop depending on the runner's cwd.
- `scripts/run.py quick|changed` still writes nothing: `no-log-writes.js` now
  sets `GALAXY_LOG_WRITES=off`, so the writer reports
  `Kept ... (partial run: no log writes)` truthfully, and keeps its
  `writeFileSync` stub for the direct writes left (PNG frames, PPM traces).
  `all-tests` (and `quick|changed --logs`) writes normally.

**Validation.** `experiments/log-file-test.js` (wired into `run.py` as
`log-file`, 10/10): first write creates the directory, a date-only rerun leaves
the bytes *and the mtime* untouched, indent differences alone do not rewrite, a
changed check / added or dropped field / nested `date` writes, a no-`date` log
still skips an identical rerun, a corrupt file is replaced, the partial-run
switch keeps the file, and `indent: 0` writes the compact form. Full
`all-tests` 36/36 in 202 s. Re-running `all-tests` afterwards left only the 13
logs that carry measured timings changed and every deterministic log (camera,
hdr, m1-smoke, route, shape, orbit, …) untouched — the point of the change;
those timing logs were reverted rather than committed.

Next: the same rule for `experiments/tile-encoder.js`'s generated
`src/data/tiles/catalog.js`, whose header carries a `generated` date and which
would otherwise rewrite an identical bundle whenever it is regenerated.
