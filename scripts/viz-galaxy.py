#!/usr/bin/env python3
"""scripts/viz-galaxy.py
Reads experiments/logs/galaxy-sample.json (produced by experiments/visualize-data.js)
and renders a top-down view of the galaxy:
  - density field as background (log-scaled grayscale)
  - stars coloured by spectral class
  - nebulae as coloured circles
  - galactic centre and Sun marked

Output: /home/z/my-project/download/galaxy-viz.png
"""

import json
import os
import sys

# Font registration: per system rules, register Noto Sans SC and DejaVu Sans
# so any CJK characters fall back properly. (English-only labels here, but
# consistent with project conventions.)
import matplotlib
matplotlib.use('Agg')
import matplotlib.font_manager as fm
for path in [
        '/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]:
        if os.path.exists(path):
                fm.fontManager.addfont(path)
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams['font.sans-serif'] = ['Noto Sans SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

INPUT = '/home/z/my-project/experiments/logs/galaxy-sample.json'
OUTPUT = '/home/z/my-project/download/galaxy-viz.png'

def main():
        with open(INPUT) as f:
                data = json.load(f)

        stars = data['stars']
        nebulae = data['nebulae']
        grid = np.array(data['densityGrid']).reshape(data['densityGridMeta']['N'], data['densityGridMeta']['N'])
        gm = data['densityGridMeta']

        # Density grid is indexed [i, j] = (x_idx, y_idx).
        # Build extent for imshow.
        extent = [gm['xMin'], gm['xMax'], gm['yMin'], gm['yMax']]

        fig, ax = plt.subplots(figsize=(14, 11), constrained_layout=True)

        # Background: density of total star density, midplane.
        # Use sqrt scaling to bring out arm modulation (±20%) against bulge dominance.
        density_sqrt = np.sqrt(np.maximum(grid, 0))
        im = ax.imshow(
                density_sqrt.T,
                origin='lower',
                extent=extent,
                cmap='inferno',
                aspect='equal',
                vmin=0, vmax=0.8,
                alpha=0.9,
        )

        # Overlay spiral arm curves as guide lines
        # Arm equation: m*phi = k*ln(R/Rs) + 2*pi*n
        k = np.tan(np.deg2rad(data['galaxy']['arms']['pitchDeg']))
        m = data['galaxy']['arms']['m']
        Rs = data['galaxy']['arms']['Rs']
        for n in range(m):
                R_range = np.linspace(0.5, 22, 500)
                phi_arm = (k * np.log(R_range / Rs) + 2 * np.pi * n) / m
                # Convert to Sun-centred coordinates: GC at (+8.178, 0)
                x_arm = +8.178 + R_range * np.cos(phi_arm)
                y_arm = R_range * np.sin(phi_arm)
                ax.plot(x_arm, y_arm, '-', color='cyan', alpha=0.3, linewidth=1.0)

        # Stars: colour by class. Apply size by absMag (brighter = larger).
        star_x = np.array([s['x'] for s in stars])
        star_y = np.array([s['y'] for s in stars])
        star_col = np.array([s['col'] for s in stars])
        star_size = np.array([max(0.5, 6 - 0.4 * s['absMag']) for s in stars])

        ax.scatter(
                star_x, star_y,
                c=star_col, s=star_size, alpha=0.8, edgecolors='none',
        )

        # Nebulae: coloured circles sized by their physical size.
        for n in nebulae:
                # size in kpc → points: scale up so visible
                radius_pts = max(8, n['size'] * 800)
                circle = plt.Circle(
                        (n['x'], n['y']),
                        n['size'],  # in data coords (kpc)
                        color=n['col'],
                        alpha=0.4 * n['opacity'],
                        edgecolor=n['col'],
                        linewidth=0.5,
                )
                ax.add_patch(circle)

        # Mark galactic centre and Sun
        ax.plot(+8.178, 0, 'x', color='red', markersize=14, markeredgewidth=3)
        ax.text(+8.178, 0.6, 'GC', color='red', fontsize=11, ha='center', weight='bold')
        ax.plot(0, 0, '+', color='yellow', markersize=12, markeredgewidth=2)
        ax.text(0, 0.6, 'Sun', color='yellow', fontsize=10, ha='center', weight='bold')

        # Legend for spectral classes
        legend_handles = []
        legend_labels = []
        class_colors = {
                'O': '#99B3FF', 'B': '#C0CCFF', 'A': '#F2F2FF', 'F': '#FFFAEB',
                'G': '#FFF2C0', 'K': '#FFC780', 'M': '#FF8C66',
                'RG': '#FF664D', 'WD': '#D9D9FF',
        }
        for cls, color in class_colors.items():
                legend_handles.append(plt.Line2D([0], [0], marker='o', color='w',
                        markerfacecolor=color, markersize=8))
                legend_labels.append(cls)
        # Add nebula legend entries
        neb_colors = {
                'HII':        '#FF4D73',
                'reflection': '#80A6FF',
                'planetary':  '#66FFB3',
                'dark':       '#332E26',
                'SNR':        '#8033FF',
        }
        for t, color in neb_colors.items():
                legend_handles.append(plt.Line2D([0], [0], marker='o', color='w',
                        markerfacecolor=color, markersize=10, alpha=0.6,
                        markeredgecolor=color))
                legend_labels.append(f'Neb: {t}')

        ax.legend(legend_handles, legend_labels, loc='upper left', fontsize=9,
                framealpha=0.85, ncol=2)

        ax.set_xlabel('X (kpc, Sun-centred)')
        ax.set_ylabel('Y (kpc)')
        ax.set_title('Galaxy Fly-Through — top-down view (z=0 plane)\n'
                'Density (sqrt-scaled, inferno) + stars (colored by class) + nebulae (circles)\n'
                'Cyan curves = spiral arm centres')
        ax.set_xlim(extent[0], extent[1])
        ax.set_ylim(extent[2], extent[3])

        # Colorbar for density
        cbar = fig.colorbar(im, ax=ax, shrink=0.7, pad=0.02)
        cbar.set_label('sqrt(star density)')

        os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
        fig.savefig(OUTPUT, dpi=140)
        plt.close(fig)
        print(f'Wrote {OUTPUT}')

if __name__ == '__main__':
        main()
