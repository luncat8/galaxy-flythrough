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
    python3 scripts/run.py density-distribution
    python3 scripts/run.py star-types-evolution
    python3 scripts/run.py nebula-placement
    python3 scripts/run.py tile-encoder-smoke
    python3 scripts/run.py visualize-data
    python3 scripts/run.py encode-mock-tiles
    python3 scripts/run.py all-tests
    python3 scripts/run.py serve
    python3 scripts/run.py zip
    python3 scripts/run.py list
"""

import argparse
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EXPERIMENTS = {
    'hash-quality':          'experiments/hash-quality-test.js',
    'precision':             'experiments/precision-test.js',
    'packing':               'experiments/packing-test.js',
    'filter':                'experiments/filter-test.js',
    'wgsl-validate':         'experiments/wgsl-validate.js',
    'm1-smoke':              'experiments/m1-smoke-test.js',
    'density-distribution':  'experiments/density-distribution-test.js',
    'star-types-evolution':  'experiments/star-types-evolution-test.js',
    'nebula-placement':      'experiments/nebula-placement-test.js',
    'tile-encoder-smoke':    'experiments/tile-encoder-smoke-test.js',
    'visualize-data':        'experiments/visualize-data.js',
}

# Compound commands (Python script or shell sequence)
COMPOUND = {
    'encode-mock-tiles': {
        'desc': 'Generate mock stars and encode them to tile files',
        'cmd':  ['node', 'experiments/tile-encoder.js', '--mock', '--output', 'src/data/tiles/'],
    },
    'all-tests': {
        'desc': 'Run all validation + model tests in sequence',
        'cmd':  None,  # special: iterate EXPERIMENTS except visualize-data
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
        print('Validation tests:')
        for k in ['hash-quality', 'precision', 'packing', 'filter', 'wgsl-validate', 'm1-smoke', 'tile-encoder-smoke']:
            print(f'  {k}')
        print()
        print('Model tests:')
        for k in ['density-distribution', 'star-types-evolution', 'nebula-placement']:
            print(f'  {k}')
        print()
        print('Asset generation:')
        for k in ['visualize-data', 'encode-mock-tiles', 'viz-png']:
            print(f'  {k}')
        print()
        print('Other:')
        for k in ['all-tests', 'serve', 'zip']:
            print(f'  {k}')
        return 0

    if name == 'all-tests':
        print('Running all validation + model tests...')
        print()
        rc = 0
        for k in ['hash-quality', 'precision', 'packing', 'filter', 'wgsl-validate',
                  'm1-smoke', 'tile-encoder-smoke',
                  'density-distribution', 'star-types-evolution', 'nebula-placement']:
            print(f'=== {k} ===')
            rc2 = run(k)
            if rc2 != 0:
                rc = rc2
            print()
        if rc == 0:
            print('ALL TESTS PASSED')
        else:
            print(f'SOME TESTS FAILED (rc={rc})')
        return rc

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


def main():
    p = argparse.ArgumentParser(
        description='Convenience wrapper for galaxy fly-through project scripts.',
        usage='python3 scripts/run.py <command>',
    )
    p.add_argument('command', help='Command to run (use "list" to see all)')
    args = p.parse_args()

    sys.exit(run(args.command))


if __name__ == '__main__':
    main()
