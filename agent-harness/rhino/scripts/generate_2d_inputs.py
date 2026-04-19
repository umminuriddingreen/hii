#!/usr/bin/env python3
"""
Generate 2D architectural input images for 5 experimental chains.
Scenario A: Design Object — Sculptural Pavilion / Art Installation

Chain 1: Abstract ink brush sketch → organic flowing pavilion
Chain 2: Voronoi/cellular diagram → perforated shell structure
Chain 3: Force/tension diagram → tensile canopy structure
Chain 4: Geological strata section → layered carved monolith
Chain 5: Radial symmetry pattern → crystalline tower/spire
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math
import os
import random

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "chains")
SIZE = (1024, 1024)
random.seed(42)
np.random.seed(42)


def chain1_ink_sketch():
    """Abstract ink brush strokes suggesting an organic flowing pavilion."""
    img = Image.new("RGB", SIZE, (245, 240, 232))  # warm paper tone
    draw = ImageDraw.Draw(img)

    # Flowing curves like ink brush strokes
    for _ in range(8):
        points = []
        x, y = random.randint(200, 800), random.randint(600, 900)
        for i in range(60):
            x += random.randint(-15, 15) + math.sin(i * 0.15) * 12
            y -= random.randint(3, 12)
            points.append((x, y))
        if len(points) > 2:
            # Variable width brush effect
            for j in range(len(points) - 1):
                width = int(3 + 8 * math.sin(j / len(points) * math.pi))
                opacity = random.randint(40, 90)
                draw.line([points[j], points[j + 1]], fill=(opacity, opacity, opacity), width=width)

    # Ground plane suggestion
    draw.line([(100, 850), (924, 850)], fill=(60, 60, 60), width=2)

    # A few bold anchor strokes
    for _ in range(3):
        cx, cy = random.randint(350, 650), random.randint(300, 600)
        pts = [(cx + math.cos(a) * random.randint(50, 200),
                cy + math.sin(a) * random.randint(30, 150))
               for a in np.linspace(0, math.pi * 1.5, 25)]
        draw.line(pts, fill=(20, 20, 20), width=5)

    img = img.filter(ImageFilter.GaussianBlur(1.2))
    out = os.path.join(OUTPUT_DIR, "chain1", "inputs", "ink_sketch_organic_pavilion.png")
    img.save(out)
    print(f"  Saved: {out}")
    return out


def chain2_voronoi_diagram():
    """Voronoi/cellular pattern suggesting a perforated shell structure."""
    img = Image.new("RGB", SIZE, (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Generate random points for voronoi-like cells
    points = [(random.randint(50, 974), random.randint(50, 974)) for _ in range(80)]

    # Draw cells as circles with connecting lines (approximate voronoi)
    for i, (x1, y1) in enumerate(points):
        # Find nearest neighbors
        dists = [(math.hypot(x2 - x1, y2 - y1), x2, y2) for j, (x2, y2) in enumerate(points) if i != j]
        dists.sort()
        for d, x2, y2 in dists[:4]:
            if d < 200:
                draw.line([(x1, y1), (x2, y2)], fill=(40, 40, 40), width=2)

    # Draw cell centers
    for x, y in points:
        r = random.randint(3, 8)
        draw.ellipse([(x - r, y - r), (x + r, y + r)], fill=(20, 20, 20))

    # Overlay a dome-like silhouette mask
    mask = Image.new("L", SIZE, 0)
    mask_draw = ImageDraw.Draw(mask)
    # Dome shape
    dome_pts = []
    for a in np.linspace(0, math.pi, 100):
        x = 512 + math.cos(a) * 400
        y = 850 - math.sin(a) * 500
        dome_pts.append((x, y))
    dome_pts.append((912, 850))
    dome_pts.append((112, 850))
    mask_draw.polygon(dome_pts, fill=255)

    # Apply mask
    bg = Image.new("RGB", SIZE, (255, 255, 255))
    img = Image.composite(img, bg, mask)

    # Draw dome outline
    draw2 = ImageDraw.Draw(img)
    outline_pts = [(512 + math.cos(a) * 400, 850 - math.sin(a) * 500)
                   for a in np.linspace(0, math.pi, 100)]
    draw2.line(outline_pts, fill=(10, 10, 10), width=3)
    draw2.line([(112, 850), (912, 850)], fill=(10, 10, 10), width=3)

    out = os.path.join(OUTPUT_DIR, "chain2", "inputs", "voronoi_shell_structure.png")
    img.save(out)
    print(f"  Saved: {out}")
    return out


def chain3_force_diagram():
    """Force/tension vectors suggesting a tensile canopy."""
    img = Image.new("RGB", SIZE, (250, 248, 245))
    draw = ImageDraw.Draw(img)

    # Anchor points at ground
    anchors = [(150, 800), (500, 850), (850, 800)]
    # Peak points
    peaks = [(300, 250), (700, 200), (500, 350)]

    # Draw tension lines (catenary-like curves)
    for ax, ay in anchors:
        for px, py in peaks:
            pts = []
            for t in np.linspace(0, 1, 40):
                x = ax + (px - ax) * t
                sag = 50 * math.sin(t * math.pi) * (1 - t)
                y = ay + (py - ay) * t + sag
                pts.append((x, y))
            draw.line(pts, fill=(180, 50, 30), width=2)

    # Draw compression members (vertical masts)
    for px, py in peaks:
        draw.line([(px, py), (px, 850)], fill=(30, 30, 30), width=4)
        # Arrow at top
        draw.polygon([(px - 8, py + 15), (px + 8, py + 15), (px, py)], fill=(30, 30, 30))

    # Force arrows
    for ax, ay in anchors:
        draw.ellipse([(ax - 6, ay - 6), (ax + 6, ay + 6)], fill=(30, 30, 30))
        # Ground anchor symbol
        for dx in range(-15, 16, 6):
            draw.line([(ax + dx, ay + 8), (ax + dx - 5, ay + 20)], fill=(100, 100, 100), width=1)

    # Membrane surface suggestion (light fill between curves)
    membrane_pts = []
    for t in np.linspace(0, 1, 50):
        x = 150 + 700 * t
        y = 800 - 500 * math.sin(t * math.pi) * (0.5 + 0.3 * math.sin(t * 3))
        membrane_pts.append((x, y))
    membrane_pts.extend([(850, 800), (150, 800)])
    overlay = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    overlay_draw.polygon(membrane_pts, fill=(180, 50, 30, 30))
    img.paste(Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB"))

    # Ground line
    draw = ImageDraw.Draw(img)
    draw.line([(50, 850), (974, 850)], fill=(60, 60, 60), width=2)

    out = os.path.join(OUTPUT_DIR, "chain3", "inputs", "force_diagram_tensile.png")
    img.save(out)
    print(f"  Saved: {out}")
    return out


def chain4_geological_strata():
    """Geological strata cross-section suggesting a layered carved monolith."""
    img = Image.new("RGB", SIZE, (245, 240, 235))
    draw = ImageDraw.Draw(img)

    # Color palette for strata layers
    colors = [
        (180, 160, 140), (160, 140, 120), (200, 180, 160),
        (140, 130, 115), (170, 155, 135), (190, 175, 155),
        (130, 120, 105), (175, 160, 140), (155, 145, 125),
        (185, 170, 150), (145, 135, 118), (165, 150, 132),
    ]

    # Draw strata as wavy horizontal bands within a monolith silhouette
    num_layers = 12
    layer_h = 700 / num_layers

    for i in range(num_layers):
        base_y = 150 + i * layer_h
        pts_top = []
        pts_bottom = []

        for x in range(150, 875):
            wave = 15 * math.sin(x * 0.02 + i * 0.7) + 8 * math.sin(x * 0.05 + i * 1.3)
            # Taper sides for monolith shape
            taper = 1.0 - 0.3 * abs(x - 512) / 362
            if taper < 0:
                continue
            y_top = base_y + wave * taper
            y_bottom = base_y + layer_h + wave * taper
            pts_top.append((x, y_top))
            pts_bottom.append((x, y_bottom))

        if pts_top and pts_bottom:
            poly = pts_top + list(reversed(pts_bottom))
            draw.polygon(poly, fill=colors[i % len(colors)])
            draw.line(pts_top, fill=(80, 70, 60), width=1)

    # Monolith outline
    outline = [
        (200, 850), (180, 150), (250, 100), (400, 80), (600, 75),
        (750, 90), (830, 140), (810, 850), (200, 850)
    ]
    draw.line(outline, fill=(40, 35, 30), width=3)

    # Ground
    draw.line([(50, 850), (974, 850)], fill=(60, 60, 60), width=2)

    out = os.path.join(OUTPUT_DIR, "chain4", "inputs", "geological_strata_monolith.png")
    img.save(out)
    print(f"  Saved: {out}")
    return out


def chain5_radial_pattern():
    """Radial symmetry pattern suggesting a crystalline tower/spire."""
    img = Image.new("RGB", SIZE, (10, 10, 20))
    draw = ImageDraw.Draw(img)

    cx, cy = 512, 512
    num_arms = 12

    for arm in range(num_arms):
        base_angle = arm * (2 * math.pi / num_arms)

        for seg in range(1, 8):
            r_inner = seg * 55
            r_outer = (seg + 1) * 55
            # Crystal facet
            a1 = base_angle - 0.12
            a2 = base_angle + 0.12

            pts = [
                (cx + r_inner * math.cos(a1), cy + r_inner * math.sin(a1)),
                (cx + r_outer * math.cos(a1 - 0.03), cy + r_outer * math.sin(a1 - 0.03)),
                (cx + r_outer * math.cos(a2 + 0.03), cy + r_outer * math.sin(a2 + 0.03)),
                (cx + r_inner * math.cos(a2), cy + r_inner * math.sin(a2)),
            ]
            brightness = 200 - seg * 20
            color = (brightness, brightness + 20, brightness + 40)
            draw.polygon(pts, fill=color, outline=(220, 230, 240))

        # Radial line
        draw.line([
            (cx + 50 * math.cos(base_angle), cy + 50 * math.sin(base_angle)),
            (cx + 420 * math.cos(base_angle), cy + 420 * math.sin(base_angle))
        ], fill=(200, 210, 230), width=1)

    # Center point
    draw.ellipse([(cx - 15, cy - 15), (cx + 15, cy + 15)], fill=(240, 245, 255), outline=(200, 210, 230))

    # Concentric rings
    for r in range(55, 450, 55):
        draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], outline=(60, 70, 90), width=1)

    out = os.path.join(OUTPUT_DIR, "chain5", "inputs", "radial_crystalline_spire.png")
    img.save(out)
    print(f"  Saved: {out}")
    return out


if __name__ == "__main__":
    print("Generating 2D inputs for 5 experimental chains...")
    print("Scenario A: Design Object — Sculptural Pavilion\n")

    print("Chain 1: Abstract ink sketch → organic flowing pavilion")
    chain1_ink_sketch()

    print("Chain 2: Voronoi diagram → perforated shell structure")
    chain2_voronoi_diagram()

    print("Chain 3: Force/tension diagram → tensile canopy")
    chain3_force_diagram()

    print("Chain 4: Geological strata section → layered monolith")
    chain4_geological_strata()

    print("Chain 5: Radial symmetry pattern → crystalline spire")
    chain5_radial_pattern()

    print("\nDone! All inputs saved to chains/chain*/inputs/")
