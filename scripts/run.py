#!/usr/bin/env python3
"""scripts/run.py

Convenience wrapper to run any experiment or asset-generation script
without remembering Node arguments. Just `python3 scripts/run.py <name>`.

Usage:
    python3 scripts/run.py hash-quality
    python3 scripts/run.py precision
    python3 scripts/run.py packing
    python3 scripts/run.py filter
    python3 scripts/run.py wgsl-validate
    python3 scripts/run.py m1-smoke
    python3 scripts/run.py landmark
    python3 scripts/run.py density-distribution
    python3 scripts/run.py star-types-evolution
    python3 scripts/run.py galaxy-types
    python3 scripts/run.py model-parity
    python3 scripts/run.py nebula-placement
    python3 scripts/run.py tile-encoder-smoke
    python3 scripts/run.py view-modes-layer
    python3 scripts/run.py wgsl-exec
    python3 scripts/run.py visualize-data
    python3 scripts/run.py encode-mock-tiles
    python3 scripts/run.py quick          # fast tier, ~15 s: the default check
    python3 scripts/run.py field-tests    # galaxy/density/movement model (~147 s)
    python3 scripts/run.py view-tests     # shaders/render/streaming/camera/view-modes (~9 s)
    python3 scripts/run.py world-tests    # planets/selection/search/flight/trade (~13 s)
    python3 scripts/run.py changed        # only the tests the working tree can affect
    python3 scripts/run.py all-tests      # everything: before a merge or a model change
    python3 scripts/run.py serve
    python3 scripts/run.py zip
    python3 scripts/run.py list
"""

import argparse
import os
import re
import subprocess
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Pass/fail tests. `all-tests` runs everything in TYPES['test'] in this order:
# engineering checks first (cheap, catch wiring mistakes), then model tests.
EXPERIMENTS = {
    'export-parity':         'experiments/export-parity-test.js',
    'log-file':              'experiments/log-file-test.js',
    'm1-smoke':              'experiments/m1-smoke-test.js',
    'panel':                 'experiments/panel-test.js',
    'wgsl-validate':         'experiments/wgsl-validate.js',
    'camera':                'experiments/camera-test.js',
    'input':                 'experiments/input-test.js',
    'workspace':             'experiments/workspace-test.js',
    'ship':                  'experiments/ship-test.js',
    'preset':                'experiments/preset-test.js',
    'renderer':              'experiments/renderer-test.js',
    'hdr':                   'experiments/hdr-test.js',
    'landmark':              'experiments/landmark-test.js',
    'view-modes-field':      'experiments/view-modes-field-test.js',
    'view-modes-page':       'experiments/view-modes-page-check.js',
    'view-modes-layer':      'experiments/view-modes-layer-test.js',
    'tile-stream':           'experiments/tile-stream-test.js',
    'tile-encoder-smoke':    'experiments/tile-encoder-smoke-test.js',
    'galaxy-types':          'experiments/galaxy-types-test.js',
    'shape':                 'experiments/shape-test.js',
    'model-parity':          'experiments/model-parity-test.js',
    'sampling':              'experiments/sampling-test.js',
    'density-distribution':  'experiments/density-distribution-test.js',
    'star-types-evolution':  'experiments/star-types-evolution-test.js',
    'planet-gen':            'experiments/planet-gen-test.js',
    'star-select':           'experiments/star-select-test.js',
    'selection-store':       'experiments/selection-store-test.js',
    'search':                'experiments/search-test.js',
    'nebula-placement':      'experiments/nebula-placement-test.js',
    'object-placement':      'experiments/object-placement-test.js',
    'star-cluster':          'experiments/star-cluster-test.js',
    'galaxy-age':            'experiments/galaxy-age-test.js',
    'galaxy-evolution':      'experiments/galaxy-evolution-test.js',
    'orbit':                 'experiments/orbit-test.js',
    'movement-density':      'experiments/movement-density-test.js',
    'system-layer':          'experiments/system-layer-test.js',
    'dv-map':                'experiments/dv-map-test.js',
    'route':                 'experiments/route-test.js',
    'trade':                 'experiments/trade-test.js',
    'exec-queue':            'experiments/exec-queue-test.js',
    # Studies: they print a recommendation rather than pass/fail.
    'damping-formula':     'experiments/damping-formula-check.js',
    'hash-quality':          'experiments/hash-quality-test.js',
    'precision':             'experiments/precision-test.js',
    'packing':               'experiments/packing-test.js',
    'filter':                'experiments/filter-test.js',
    'truncation-edge':       'experiments/truncation-edge.js',
    'young-vertical':        'experiments/young-vertical.js',
    # Needs one dev-only dependency: `npm install wgsl_reflect` at the repo
    # root. Executes the shipping WGSL on the CPU; not part of all-tests.
    'wgsl-exec':             'experiments/wgsl-exec-check.js',
    # Asset generation / visualisation.
    'tile-encoder':          'experiments/tile-encoder.js',
    'visualize-data':        'experiments/visualize-data.js',
}

TYPES = {
    'test':   ['export-parity', 'log-file', 'm1-smoke', 'panel', 'wgsl-validate', 'camera', 'input', 'workspace', 'ship', 'preset', 'renderer', 'hdr',
               'landmark', 'view-modes-field', 'view-modes-page', 'view-modes-layer',
               'tile-stream', 'tile-encoder-smoke', 'galaxy-types', 'shape', 'model-parity', 'sampling',
               'density-distribution',
               'star-types-evolution', 'planet-gen', 'star-select', 'selection-store', 'search', 'nebula-placement', 'object-placement',
               'star-cluster',
               'galaxy-age', 'galaxy-evolution', 'orbit', 'movement-density', 'system-layer', 'dv-map', 'route', 'trade', 'exec-queue'],
    'study':  ['damping-formula', 'hash-quality', 'precision', 'packing', 'filter',
               'truncation-edge', 'young-vertical'],
    'sim':    ['wgsl-exec'],
    'asset':  ['tile-encoder', 'visualize-data'],
}

# Measured wall time (s, serial, 2-core sandbox, 2026-10-16) of every test that
# takes more than ~5 s. Everything else is the fast tier (≈15 s together). The
# slow ones are model/statistics gates: they only say something new when the
# model they measure changed, which `changed` detects from the dependency graph.
SLOW = {
    'movement-density': 83, 'density-distribution': 16, 'galaxy-evolution': 11,
    'galaxy-age': 9, 'galaxy-types': 8, 'search': 6, 'star-types-evolution': 6,
    'object-placement': 6, 'star-select': 5, 'shape': 5,
}
FAST = [k for k in TYPES['test'] if k not in SLOW]
# Wiring tests that cost nothing and catch the most common mistakes; `changed`
# always includes them.
ALWAYS = ['export-parity', 'm1-smoke']
NO_LOG_WRITES = ROOT / 'experiments' / 'no-log-writes.js'

# Domain split along the one-way dependency DAG:
#   field  ──► view
#   field  ──► world
# `field-tests` holds ~88% of `all-tests` wall time and has zero dependency on
# `view` or `world`. Editing `world` (colonisation, trade, planets, flight) or
# `view` (shaders, streaming, view-modes, panels) needs only that tier (~9–13 s);
# editing `field` (`density`, `galaxy`, `sampling`, `orbit` / star movement)
# affects downstream consumers, where adding `view-tests + world-tests` on top
# of `field-tests` costs only ~20 s (`all-tests` or `changed`).
SUITES = {
    'field-tests': ALWAYS + [
        'galaxy-types', 'shape', 'model-parity', 'sampling', 'density-distribution',
        'star-types-evolution', 'nebula-placement', 'object-placement', 'star-cluster',
        'galaxy-age', 'galaxy-evolution', 'orbit', 'movement-density',
    ],
    'view-tests': ALWAYS + [
        'log-file', 'panel', 'wgsl-validate', 'camera', 'input', 'preset',
        'renderer', 'hdr', 'landmark', 'view-modes-field', 'view-modes-page',
        'view-modes-layer', 'tile-stream', 'tile-encoder-smoke',
    ],
    'world-tests': ALWAYS + [
        'panel', 'preset', 'workspace', 'planet-gen', 'star-select', 'selection-store',
        'search', 'system-layer', 'dv-map', 'route', 'ship', 'trade', 'exec-queue',
    ],
}
assert set().union(*SUITES.values()) == set(TYPES['test']), 'SUITES must cover TYPES["test"]'

# Compound commands (Python script or shell sequence)
COMPOUND = {
    'encode-mock-tiles': {
        'desc': 'Generate mock stars and encode them into src/data/tiles/catalog.js',
        'cmd':  ['node', 'experiments/tile-encoder.js', '--mock', '--output', 'src/data/tiles/catalog.js'],
    },
    'all-tests': {
        'desc': 'Run all validation + model tests in sequence',
        'cmd':  None,
    },
    'field-tests': {
        'desc': 'Galaxy density, morphology, evolution and star movement tests',
        'cmd':  None,
    },
    'view-tests': {
        'desc': 'Shaders, renderer, streaming, camera, view-modes and panel tests',
        'cmd':  None,
    },
    'world-tests': {
        'desc': 'Planets, selection, search, delta-v, flight, colonisation and trade tests',
        'cmd':  None,
    },
    'quick': {
        'desc': 'Fast tier only (skips the slow model/statistics gates)',
        'cmd':  None,
    },
    'changed': {
        'desc': 'Only the tests whose source files changed (dependency graph)',
        'cmd':  None,
    },
    'serve': {
        'desc': 'Start a local HTTP server for src/ (open http://localhost:8080)',
        'cmd':  ['python3', '-m', 'http.server', '8080', '--directory', 'src'],
    },
    'viz-png': {
        'desc': 'Render the galaxy visualization PNG (requires galaxy-sample.json)',
        'cmd':  ['python3', 'scripts/viz-galaxy.py'],
    },
    'zip': {
        'desc': 'Create project zip for download',
        'cmd':  ['python3', 'scripts/zip-project.py'],
    },
}


def run(name: str) -> int:
    if name == 'list':
        print('Available commands:')
        print()
        print('Tests (pass/fail, run by all-tests):')
        for k in TYPES['test']:
            print(f'  {k}')
        print()
        print('Studies (print a recommendation):')
        for k in TYPES['study']:
            print(f'  {k}')
        print()
        print('Shader simulation (needs `npm install wgsl_reflect`):')
        for k in TYPES['sim']:
            print(f'  {k}')
        print()
        print('Assets and other:')
        for k in TYPES['asset'] + ['encode-mock-tiles', 'viz-png']:
            print(f'  {k}')
        print()
        print('Domain suites (3-way DAG split of all-tests):')
        for k, members in SUITES.items():
            print(f'  {k:<14} ({len(members)} tests)')
        print()
        print('Slow tier (skipped by quick, run by all-tests and by changed when affected):')
        print('  ' + ', '.join(f'{k} ({SLOW[k]}s)' for k in SLOW))
        print()
        print('Other:')
        for k in ['quick', 'field-tests', 'view-tests', 'world-tests', 'changed', 'all-tests', 'serve', 'zip']:
            print(f'  {k}')
        return 0

    if name in EXPERIMENTS:
        script = ROOT / EXPERIMENTS[name]
        if not script.exists():
            print(f'Not found: {script}', file=sys.stderr)
            return 1
        cmd = ['node', str(script)]
    elif name in COMPOUND:
        c = COMPOUND[name]
        print(f'-- {name}: {c["desc"]}')
        cmd = c['cmd']
    else:
        print(f'Unknown command: {name}', file=sys.stderr)
        print(f'Run "{sys.argv[0]} list" to see available commands.', file=sys.stderr)
        return 1

    # Run from project root
    print(f'$ {" ".join(cmd)}')
    result = subprocess.run(cmd, cwd=str(ROOT))
    return result.returncode


# --- Test tiers ---------------------------------------------------------------

def run_test(name: str, write_logs: bool):
    """One test, output captured. Logs under experiments/logs are only written
    for a full run: a partial run must not dirty the tree with timestamps and
    timings of the tests it ran. A full run that changes nothing but a log's
    `date` keeps the file it already has (experiments/log-file.js)."""
    cmd = ['node']
    if not write_logs:
        cmd += ['--require', str(NO_LOG_WRITES)]
    cmd.append(str(ROOT / EXPERIMENTS[name]))
    started = time.time()
    result = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    return name, result.returncode, time.time() - started, result.stdout + result.stderr


FAILURE_LINE = re.compile(r'fail|error|assert|expected|✗', re.I)


def failure_excerpt(output: str, verbose: bool) -> str:
    """The failing checks plus the verdict tail; a test prints 70 OK lines for
    one FAIL, and the agent reading this does not need the 70."""
    lines = output.splitlines()
    if verbose:
        return output
    picked = [line for line in lines[:-6] if FAILURE_LINE.search(line)]
    return '\n'.join(picked + lines[-6:]) + '\n'


def run_suite(names, jobs: int, write_logs: bool, label: str, verbose: bool = False) -> int:
    """Run `names`, print only failures in full, then a timing table.
    Passing tests print one line; a failing test prints its whole output."""
    if not names:
        print(f'{label}: no tests to run')
        return 0
    print(f'{label}: {len(names)} tests' + (f', {jobs} jobs' if jobs > 1 else ''))
    started = time.time()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = list(pool.map(lambda n: run_test(n, write_logs), names))
    failed = []
    for name, rc, seconds, output in results:
        print(f'  {"ok  " if rc == 0 else "FAIL"} {name:<24} {seconds:6.1f}s')
        if rc == 0:
            continue
        failed.append(name)
        print(failure_excerpt(output, verbose))
    print(f'{label}: {len(names) - len(failed)}/{len(names)} passed in {time.time() - started:.1f}s')
    if failed:
        print('FAILED: ' + ', '.join(failed))
        return 1
    return 0


SOURCE_SUFFIXES = ('.js', '.html', '.css', '.csv')
STRING_FILE = re.compile(r"""['"`][^'"`\n]*?([\w-]+\.(?:js|html|css|csv))['"`]""")


HTML_SCRIPT = re.compile(r"""<script\b[^>]*\bsrc=['"]([^'"]*?[\w-]+\.js)['"]""", re.I)


def strip_comments(text: str) -> str:
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'^\s*//.*$', '', text, flags=re.M)


def dependency_index():
    """{test name: set of repo files it can observe}. A file is a dependency
    when its basename appears in a string literal (require paths, readFileSync
    targets), followed transitively through src/ and the experiment helpers.
    HTML pages only forward <script src> tags (and `index.html` is already
    booted unconditionally by `m1-smoke` in ALWAYS, so DOM-markup readers of
    `index.html` do not inherit every script in the app)."""
    tests = {ROOT / EXPERIMENTS[k] for k in TYPES['test']}
    by_name = {}
    for top in ('src', 'experiments'):
        for path in (ROOT / top).rglob('*'):
            skip = path in tests or 'logs' in path.parts or 'node_modules' in path.parts
            if path.is_file() and path.suffix in SOURCE_SUFFIXES and not skip:
                by_name.setdefault(path.name, []).append(path)
    edges = {}

    def direct(path):
        if path not in edges:
            text = path.read_text(errors='ignore')
            if path.suffix == '.html':
                names = [] if path.name == 'index.html' else [Path(s).name for s in HTML_SCRIPT.findall(text)]
            else:
                names = STRING_FILE.findall(strip_comments(text))
            edges[path] = {q for n in names for q in by_name.get(n, []) if q != path}
        return edges[path]

    index = {}
    for name in TYPES['test']:
        root = ROOT / EXPERIMENTS[name]
        seen, stack = set(), [root]
        while stack:
            for dep in direct(stack.pop()):
                if dep not in seen:
                    seen.add(dep)
                    stack.append(dep)
        seen.add(root)
        index[name] = seen
    return index


def changed_files(base):
    """Working-tree changes against HEAD (staged, unstaged, untracked), plus the
    commits since `base` when given (a branch review)."""
    def git(*args):
        out = subprocess.run(['git', *args], cwd=str(ROOT), capture_output=True, text=True).stdout
        return {ROOT / line for line in out.splitlines() if line}
    files = git('diff', '--name-only', 'HEAD') | git('ls-files', '--others', '--exclude-standard')
    if base:
        files |= git('diff', '--name-only', f'{base}...HEAD')
    return files


def affected_tests(base):
    changed = changed_files(base)
    index = dependency_index()
    names = [k for k in TYPES['test'] if k in ALWAYS or index[k] & changed]
    covered = set().union(*index.values())
    uncovered = sorted(str(p.relative_to(ROOT)) for p in changed
                       if p.suffix in SOURCE_SUFFIXES and p.parts[len(ROOT.parts)] == 'src'
                       and 'logs' not in p.parts and p not in covered and p.exists())
    return names, uncovered


def expand_targets(targets):
    """Expand test names and suite names (`field-tests`, `view-tests`,
    `world-tests`, `quick`) into a deduplicated test list."""
    out, seen = [], set()
    for target in targets:
        members = SUITES.get(target) or (FAST if target == 'quick' else [target])
        for m in members:
            if m not in seen:
                seen.add(m)
                out.append(m)
    return out


def main():
    p = argparse.ArgumentParser(
        description='Convenience wrapper for galaxy fly-through project scripts.',
        usage='python3 scripts/run.py <command>',
    )
    p.add_argument('command', nargs='+',
                   help='Command to run (use "list" to see all), or test/suite names to run together')
    p.add_argument('-j', '--jobs', type=int, default=1,
                   help='parallel tests for suites/quick/changed/all-tests; timing budgets inside '
                        'tests can fail under load, so the default is serial')
    p.add_argument('--logs', action='store_true',
                   help='suites/quick/changed: also write experiments/logs (all-tests always does); '
                        'a log that differs only in its date is kept')
    p.add_argument('-v', '--verbose', action='store_true', help='print the full output of failing tests')
    p.add_argument('--base', default=None, help='changed: also include commits since this ref (e.g. main)')
    args = p.parse_args()

    names = args.command
    selectable = set(TYPES['test']) | set(SUITES) | {'quick'}
    if len(names) == 1 and names[0] == 'changed':
        picked, uncovered = affected_tests(args.base)
        for path in uncovered:
            print(f'note: {path} is not read by any test')
        sys.exit(run_suite(picked, args.jobs, args.logs, 'changed', args.verbose))
    if len(names) == 1 and names[0] == 'all-tests':
        sys.exit(run_suite(TYPES['test'], args.jobs, True, 'all-tests', args.verbose))
    if len(names) > 1 or names[0] in selectable:
        unknown = [n for n in names if n not in selectable]
        if unknown:
            print(f'Not a pass/fail test or suite: {", ".join(unknown)} (run "list")', file=sys.stderr)
            sys.exit(1)
        label = names[0] if len(names) == 1 else '+'.join(names)
        sys.exit(run_suite(expand_targets(names), args.jobs, args.logs, label, args.verbose))
    sys.exit(run(args.command))


if __name__ == '__main__':
    main()
