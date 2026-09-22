#!/usr/bin/env python3
"""scripts/viz-galaxy.py
Reads experiments/logs/galaxy-sample.json (produced by experiments/visualize-data.js)
and renders three views of the galaxy:
  - density field as background (log-scaled grayscale)
  - stars coloured by spectral class
  - nebulae as coloured circles
  - galactic centre and Sun marked

The middle panel is the same field's arm modulation, rho divided by its own
azimuthal mean at that radius. The arms are a 15-25% modulation of a disc that
falls off by a factor of thousands, so on the raw density they are invisible;
divided out, they are the whole picture, and the pitch angle is readable by eye.

The right-hand panel is the model edge-on (the x-z slice through its centre,
zoomed to the inner 16 x 4.4 kpc), which is the view a boxy/peanut bar shows its
shape in.

Output: /home/z/my-project/download/galaxy-viz.png
"""

import json
import os
import sys

# Font registration: per system rules, register Noto Sans SC and DejaVu Sans
# so any CJK characters fall back properly. (English-only labels here, but
# consistent with project conventions.)
try:
        import matplotlib
except ImportError:
        print('matplotlib is required for this script (pip install matplotlib numpy)', file=sys.stderr)
        sys.exit(1)
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT = os.environ.get('GALAXY_SAMPLE', os.path.join(ROOT, 'experiments', 'logs', 'galaxy-sample.json'))
# Written next to the checkout, not inside it: the PNG is a build artefact.
OUTPUT = os.environ.get('GALAXY_VIZ_OUT', os.path.join(os.path.dirname(ROOT), 'galaxy-viz.png'))

def main():
        with open(INPUT) as f:
                data = json.load(f)

        GC_X = data['galaxy']['centre']['x']
        GC_Y = data['galaxy']['centre']['y']
        model_type = data['galaxy'].get('type', 'SBb')
        # 0.3.3: the epoch the card was drawn at, and the gas the star-formation
        # history has left there. A sample written before the age parameter has
        # neither, so the label falls back to the type alone.
        age = data['galaxy'].get('age')
        gas_now = data['galaxy'].get('gasNow')
        model_label = model_type if age is None else f'{model_type} @ {age:g} Gyr'
        if gas_now is not None:
                model_label += f', gas {gas_now:.2f}'
        is_preset = data['galaxy'].get('preset', False)
        stars = data['stars']
        nebulae = data['nebulae']
        grid = np.array(data['densityGrid']).reshape(data['densityGridMeta']['N'], data['densityGridMeta']['N'])
        gm = data['densityGridMeta']

        # Density grid is indexed [i, j] = (x_idx, y_idx).
        # Build extent for imshow.
        extent = [gm['xMin'], gm['xMax'], gm['yMin'], gm['yMax']]

        fig, (ax, ax_mod, ax_edge) = plt.subplots(1, 3, figsize=(24, 8.5), constrained_layout=True,
                gridspec_kw={'width_ratios': [1.55, 1.0, 1.0]})

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

        # Overlay spiral arm curves as guide lines. The field's ridges solve
        # m*phi - K*ln(R/Rs) + phase0 = 2*pi*n with K = m/tan(pitch) (the
        # wavenumber a log spiral of that pitch has, density.armWavenumber), the
        # same convention the model and the shader use.
        arms = data['galaxy']['arms']
        m = arms['m']
        Rs = arms['Rs']
        phase0 = arms.get('phase0', 0.0)
        pitch = np.deg2rad(arms['pitchDeg'])
        k = m / np.tan(pitch) if pitch > 0 else 0.0
        for n in range(m):
                R_range = np.linspace(arms.get('minRadius', 0.5), 22, 2000)
                phi_arm = (k * np.log(R_range / Rs) - phase0 + 2 * np.pi * n) / m
                x_arm = GC_X + R_range * np.cos(phi_arm)
                y_arm = GC_Y + R_range * np.sin(phi_arm)
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
        ax.plot(GC_X, GC_Y, 'x', color='red', markersize=14, markeredgewidth=3)
        ax.text(GC_X, GC_Y + 0.6, 'GC', color='red', fontsize=11, ha='center', weight='bold')
        if is_preset:
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

        ax.set_xlabel('X (kpc)')
        ax.set_ylabel('Y (kpc)')
        frame = 'Sun-centred' if is_preset else 'galactocentric'
        ax.set_title(f'{model_label} — top-down view (z=0 plane), {frame}\n'
                'Density (sqrt-scaled, inferno) + stars (colored by class) + nebulae (circles)\n'
                'Cyan curves = spiral arm centres')
        ax.set_xlim(extent[0], extent[1])
        ax.set_ylim(extent[2], extent[3])

        # Middle: the same field divided by its own azimuthal mean at each radius
        # — the arm modulation. A disc falls off by orders of magnitude outward
        # and the arms are a 15-25% ripple on top of it, so they are invisible on
        # the raw map and unmissable here; the winding is readable by eye.
        gx = np.linspace(extent[0], extent[1], gm['N'])
        gy = np.linspace(extent[2], extent[3], gm['N'])
        GX, GY = np.meshgrid(gx - GC_X, gy - GC_Y, indexing='ij')
        GR = np.hypot(GX, GY)
        rbin = np.clip((GR / (0.5 * max(extent[1] - extent[0], 1e-9)) * 120).astype(int), 0, 119)
        sums = np.bincount(rbin.ravel(), weights=grid.ravel(), minlength=120)
        counts = np.bincount(rbin.ravel(), minlength=120)
        mean_r = np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)
        mod = np.where(mean_r[rbin] > 0, grid / np.maximum(mean_r[rbin], 1e-12) - 1.0, 0.0)
        # Outside the arm-bearing annulus the azimuthal mean is meaningless (the
        # halo and the truncation edge), so show only where the modulation is
        # actually defined: inside the disc's arm region.
        half_span = max(extent[1] - extent[0], extent[3] - extent[2]) * 0.5
        mod = np.where(GR < 0.85 * half_span, mod, np.nan)
        im_mod = ax_mod.imshow(
                mod.T,
                origin='lower',
                extent=extent,
                cmap='RdBu_r',
                aspect='equal',
                vmin=-0.3, vmax=0.3,
        )
        for n in range(m):
                R_range = np.linspace(arms.get('minRadius', 0.5), 22, 2000)
                phi_arm = (k * np.log(R_range / Rs) - phase0 + 2 * np.pi * n) / m
                ax_mod.plot(GC_X + R_range * np.cos(phi_arm), GC_Y + R_range * np.sin(phi_arm),
                        '-', color='black', alpha=0.35, linewidth=0.8)
        ax_mod.plot(GC_X, GC_Y, 'x', color='black', markersize=10, markeredgewidth=2)
        ax_mod.set_xlim(extent[0], extent[1])
        ax_mod.set_ylim(extent[2], extent[3])
        ax_mod.set_xlabel('X (kpc)')
        ax_mod.set_ylabel('Y (kpc)')
        ax_mod.set_title('Arm modulation (rho / azimuthal mean - 1)\n'
                f'amp = {arms["amp"]:.2f}, m = {m}, pitch = {arms["pitchDeg"]:.0f} deg\n'
                'Black curves = the ridge lines the field is written in terms of')
        cbar_mod = fig.colorbar(im_mod, ax=ax_mod, shrink=0.7, pad=0.02)
        cbar_mod.set_label('modulation')

        # Right: the same model edge-on — the x-z slice through its centre, which
        # is where a bar shows its boxy/peanut vertical structure.
        gridxz = data['densityGridXZ']
        gxz = data['densityGridXZMeta']
        extent_xz = [gxz['xMin'], gxz['xMax'], gxz['zMin'], gxz['zMax']]
        xz = np.array(gridxz).reshape(gxz['N'], gxz['NZ'])
        im_xz = ax_edge.imshow(
                np.sqrt(np.maximum(xz, 0)).T,
                origin='lower',
                extent=extent_xz,
                cmap='inferno',
                aspect='auto',
                vmin=0, vmax=0.8,
                alpha=0.9,
        )
        ax_edge.scatter(star_x, np.array([s['z'] for s in stars]),
                c=star_col, s=star_size * 0.4, alpha=0.55, edgecolors='none')
        ax_edge.plot(GC_X, 0, 'x', color='red', markersize=10, markeredgewidth=2)
        spheroid = data['galaxy'].get('spheroid')
        if data['galaxy'].get('barred') and spheroid:
                theta = np.deg2rad(spheroid['tiltDeg'])
                half = spheroid['a'] * spheroid['r0'] * np.cos(theta)
                ax_edge.plot([GC_X - half, GC_X + half], [0, 0], '--', color='cyan',
                        alpha=0.5, linewidth=1.0)
        ax_edge.set_xlabel('X (kpc, along the bar)')
        ax_edge.set_ylabel('Z (kpc)')
        ax_edge.set_title('Edge-on slice (y = centre), inner kpc\n'
                'Cyan dashed = the bar spheroid\'s projected major axis\n'
                'A boxy/peanut bar is thicker at its ends than at its middle')
        ax_edge.set_xlim(gxz['xMin'], gxz['xMax'])
        ax_edge.set_ylim(gxz['zMin'], gxz['zMax'])
        cbar_xz = fig.colorbar(im_xz, ax=ax_edge, shrink=0.7, pad=0.02)
        cbar_xz.set_label('sqrt(star density)')

        os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
        fig.savefig(OUTPUT, dpi=140)
        plt.close(fig)
        print(f'Wrote {OUTPUT}')

if __name__ == '__main__':
        main()
