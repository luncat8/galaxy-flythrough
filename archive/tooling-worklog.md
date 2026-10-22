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

## tooling.2 — generated catalogs stop rewriting themselves for a new date

**Decision.** `experiments/tile-encoder.js` now renders the catalog once, then
compares an existing `catalog.js` with the new text after replacing only the
bundle's top-level `generated` string. If the cells, payloads, metadata and
wrapper are unchanged, `writeBundle` keeps the existing file byte for byte —
including its committed date — rather than rewriting the asset. Any actual
bundle change still writes normally. The comparison is text-based so it also
preserves the exact existing wrapper and formatting, and a missing or malformed
asset falls through to the normal write.

**Validation.** `tile-encoder-smoke-test.js` is now 33/33: a rerun with a
future generated date keeps the temporary bundle byte for byte and retains the
prior date. Running the real encoder against the committed Gaia subset reports
`Kept .../src/data/tiles/catalog.js (unchanged except generated date)`; the
bundle remains at 3,829 stars in 2,045 cells and its committed generated date
is not refreshed.

Next: apply this stable-write pattern to any future generated asset that carries
provenance metadata which changes independently of its content.

## tooling.3 — three domain suites along the dependency DAG, HTML edges, and panel-test

**Decision.** Every module and test in the repository sits on a strict one-way
DAG rooted in the math/star layer (`field ──► view` and `field ──► world`, with
zero edges from `field` back into `view` or `world`). Rather than carving
arbitrary alphabetical shards, `scripts/run.py` now splits `TYPES['test']`
along those three domain subtrees — each carrying `ALWAYS = ('export-parity',
'm1-smoke')`:

- `field-tests` (15 tests, ~147 s, 88% of full-suite wall time): density,
  morphology, evolution, sampling, orbit kinematics, and movement-density.
- `view-tests` (16 tests, ~8 s): WGSL validation, star sprites, HDR, landmarks,
  tile streaming/encoding, camera, input, presets, view-modes, panels, log-file.
- `world-tests` (14 tests, ~12 s): planets, selection, search, system layer,
  delta-v, routes, ship flight, trade/colonisation, exec-queue, presets, panels.

Multiple CLI targets combine and deduplicate cleanly (`python3 scripts/run.py
view-tests world-tests` runs all 26 non-field tests in ~20 s; touching
`orbit.js` or `density.js` walks forward across `field + view + world` via
`changed` or `all-tests`). Two pre-existing runner gaps were closed alongside
the split: `experiments/panel-test.js` is now registered in `EXPERIMENTS` and
`TYPES['test']`, and `dependency_index()` parses `<script src="...">` edges on
non-`index.html` pages (`view-modes.html`) while leaving `index.html` to
`ALWAYS` instead of returning empty edges on `.html` touches.

**Validation.** Module-import assertions check that `SUITES` covers 100% of
`TYPES['test']`. `view-tests` 16/16 (7.6 s), `world-tests` 14/14 (12.0 s),
`view-tests + world-tests` 26/26 (20.8 s), `changed` on `src/core/economy.js` +
`src/core/trade.js` + `src/main.js` 6/6 (2.1 s).

Next: keep adding new `experiments/*-test.js` files to the matching domain suite
in `scripts/run.py` (enforced by the coverage assertion at import time).

