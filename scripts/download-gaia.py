#!/usr/bin/env python3
"""scripts/download-gaia.py

Download a small Gaia DR3 subset for use with the tile encoder.

The Gaia archive at https://gea.esac.esa.int/gaia/ exposes an ADQL query
endpoint. We query for the brightest ~50k stars (G < 12) within a sensible
parallax range and save as CSV.

Usage:
    python3 scripts/download-gaia.py
    python3 scripts/download-gaia.py --out src/data/gaia-subset.csv
    python3 scripts/download-gaia.py --max-stars 100000

Output: CSV file with columns:
    source_id, ra, dec, parallax, parallax_error,
    pmra, pmdec, phot_g_mean_mag, bp_rp

This file is then consumed by:
    node experiments/tile-encoder.js --input src/data/gaia-subset.csv --output src/data/tiles/

Notes:
- The Gaia archive uses TAP (Table Access Protocol) at:
  https://gea.esac.esa.int/gaia-server/tap/
- TAP sync query: POST to /sync with query=ADQL string
- We use only stdlib (urllib, csv, json, argparse) — no pip installs needed.
"""

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

# --- Defaults ---
DEFAULT_OUT = 'src/data/gaia-subset.csv'
DEFAULT_MAX_STARS = 50000
DEFAULT_MAG_LIMIT = 12.0    # completeness cut (Gaia DR3 is essentially complete to G=12)
DEFAULT_MIN_PARALLAX = 0.5  # mas — filters out very distant/inaccurate stars

TAP_URL = 'https://gea.esac.esa.int/gaia-server/tap/sync'

# --- ADQL query ---
# Gaia DR3 columns we need for the tile encoder:
#   source_id, ra, dec, parallax, parallax_error,
#   pmra, pmdec, phot_g_mean_mag, bp_rp
# We filter to G < 12 (completeness) and parallax > 0.5 mas (distance < 2 kpc).
# Top N to keep the file small (~50k stars = ~10 MB CSV).
ADQL_TEMPLATE = """
SELECT TOP {max_stars}
    source_id, ra, dec, parallax, parallax_error,
    pmra, pmdec, phot_g_mean_mag, bp_rp
FROM gaiadr3.gaia_source
WHERE phot_g_mean_mag < {mag_limit}
  AND parallax > {min_parallax}
  AND parallax_over_error > 5
ORDER BY phot_g_mean_mag ASC
""".strip()


def download(max_stars: int, mag_limit: float, min_parallax: float) -> str:
    """Run the ADQL query and return the result as CSV text."""
    adql = ADQL_TEMPLATE.format(
        max_stars=max_stars,
        mag_limit=mag_limit,
        min_parallax=min_parallax,
    )
    print('ADQL query:')
    for line in adql.split('\n'):
        print('  ' + line)
    print()

    # POST form-encoded: query=ADQL&format=csv&maxrec=N
    data = urllib.parse.urlencode({
        'query': adql,
        'format': 'csv',
        'maxrec': str(max_stars),
    }).encode('utf-8')

    req = urllib.request.Request(
        TAP_URL,
        data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
        method='POST',
    )
    print(f'POSTing to {TAP_URL}...')
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        if resp.status != 200:
            raise RuntimeError(f'HTTP {resp.status}: {resp.reason}')
        body = resp.read().decode('utf-8')
    elapsed = time.time() - t0
    print(f'Downloaded {len(body)} bytes in {elapsed:.1f}s')
    return body


def filter_and_save(csv_text: str, out_path: str) -> dict:
    """Parse the TAP CSV response, normalise, and write a clean CSV file.

    The TAP response includes a 1-line metadata header (column names with
    types). We strip that and rewrite as plain CSV.
    """
    lines = csv_text.split('\n')
    # Skip TAP metadata header (first line is `?column.name,datatype,...`)
    if lines and lines[0].startswith('?'):
        lines = lines[1:]
    # The next non-empty line is the actual column header
    header_idx = 0
    while header_idx < len(lines) and not lines[header_idx].strip():
        header_idx += 1
    if header_idx >= len(lines):
        raise RuntimeError('No CSV header found in TAP response')

    header = lines[header_idx].split(',')
    print(f'Columns: {header}')

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    written = 0
    with open(out_path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        for line in lines[header_idx + 1:]:
            line = line.strip()
            if not line:
                continue
            # Gaia TAP returns quoted source_id (large int) — strip quotes
            row = [c.strip().strip('"') for c in line.split(',')]
            if len(row) != len(header):
                continue  # skip malformed lines
            w.writerow(row)
            written += 1

    return {
        'rows_written': written,
        'columns': header,
        'out_path': out_path,
        'size_bytes': os.path.getsize(out_path),
    }


def main():
    p = argparse.ArgumentParser(description='Download a small Gaia DR3 subset for tile encoding.')
    p.add_argument('--out', default=DEFAULT_OUT,
                   help=f'Output CSV path (default: {DEFAULT_OUT})')
    p.add_argument('--max-stars', type=int, default=DEFAULT_MAX_STARS,
                   help=f'Max rows to download (default: {DEFAULT_MAX_STARS})')
    p.add_argument('--mag-limit', type=float, default=DEFAULT_MAG_LIMIT,
                   help=f'Apparent magnitude cut G < N (default: {DEFAULT_MAG_LIMIT})')
    p.add_argument('--min-parallax', type=float, default=DEFAULT_MIN_PARALLAX,
                   help=f'Minimum parallax in mas (default: {DEFAULT_MIN_PARALLAX})')
    args = p.parse_args()

    print('=== Gaia DR3 subset downloader ===')
    print(f'  output:      {args.out}')
    print(f'  max stars:   {args.max_stars}')
    print(f'  mag limit:   G < {args.mag_limit}')
    print(f'  min parallax: {args.min_parallax} mas (distance < {1000/args.min_parallax:.1f} pc)')
    print()

    try:
        csv_text = download(
            max_stars=args.max_stars,
            mag_limit=args.mag_limit,
            min_parallax=args.min_parallax,
        )
    except Exception as e:
        print(f'Download failed: {e}', file=sys.stderr)
        print('\nIf the Gaia archive is unavailable, you can:')
        print('  1. Try again later (the archive has rate limits).')
        print('  2. Use a smaller max-stars value (e.g. --max-stars 5000).')
        print('  3. Download manually from https://gea.esac.esa.int/archive/')
        print('     and place the CSV at the --out path.')
        sys.exit(1)

    try:
        stats = filter_and_save(csv_text, args.out)
    except Exception as e:
        print(f'Parse/save failed: {e}', file=sys.stderr)
        sys.exit(1)

    print()
    print('=== Done ===')
    print(f'  rows:  {stats["rows_written"]:,}')
    print(f'  size:  {stats["size_bytes"]:,} bytes ({stats["size_bytes"]/1024/1024:.1f} MB)')
    print(f'  path:  {stats["out_path"]}')
    print()
    print('Next step:')
    print(f'  node experiments/tile-encoder.js --input {args.out} --output src/data/tiles/')


if __name__ == '__main__':
    main()
