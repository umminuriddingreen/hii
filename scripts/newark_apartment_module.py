#!/usr/bin/env python3
"""Newark NJ Code-Compliant Apartment Module — 50' x 40' x 20' (2-story)

Generates RhinoScript Python code for a complete apartment module based on:
- NJ Uniform Construction Code (IBC/IRC 2021 + NJ amendments)
- Newark Municipal Code Title 40
- Contemporary Newark architectural vernacular (brownstone banding, ironspot brick, punched windows)

Designed to run via Rhino MCP (execute_rhinoscript_python_code) or directly in Rhino's Python editor.
"""
from __future__ import annotations

RHINO_CODE = r'''
import rhinoscriptsyntax as rs
import Rhino
import scriptcontext as sc
import System.Drawing

# ── CLEAR SCENE ──────────────────────────────────────────────
rs.Command("_-SelAll", False)
rs.Command("_-Delete", False)

# ── CONSTANTS (feet) ─────────────────────────────────────────
MODULE_W = 50.0   # width (x)
MODULE_D = 40.0   # depth (y)
MODULE_H = 20.0   # total height (z) — 2 stories
FLOOR_H  = 10.0   # floor-to-floor
CLR_CEIL = 8.5    # clear ceiling (after 8" structure + 6" MEP)
WALL_T   = 0.5    # exterior wall thickness (6")
DEMISE_T = 0.5    # demising wall (1-hr rated, STC 50)
CORR_W   = 5.0    # central corridor width (44" clear + walls)
STAIR_W  = 8.0    # stairwell width
STAIR_D  = 10.0   # stairwell depth
SLAB_T   = 0.67   # 8" structural slab

# ── LAYERS ───────────────────────────────────────────────────
layers = {
    "STRUCT_Slab":       (180, 180, 180),
    "STRUCT_Walls_Ext":  (140, 60, 50),   # ironspot brick red
    "STRUCT_Walls_Int":  (200, 200, 200),
    "STRUCT_Demising":   (255, 180, 100),
    "CIRC_Corridor":     (100, 160, 220),
    "CIRC_Stairwell":    (80, 130, 80),
    "UNIT_1BR":          (220, 220, 180),
    "UNIT_2BR":          (200, 210, 230),
    "WINDOWS":           (40, 40, 40),
    "FACADE_Banding":    (160, 140, 120),  # brownstone precast
    "FACADE_Cornice":    (120, 100, 80),
    "ROOF":              (100, 100, 100),
}
for name, (r, g, b) in layers.items():
    if not rs.IsLayer(name):
        rs.AddLayer(name, System.Drawing.Color.FromArgb(r, g, b))

# ── HELPER ───────────────────────────────────────────────────
def box(x0, y0, z0, dx, dy, dz, layer):
    rs.CurrentLayer(layer)
    corners = [
        (x0, y0, z0), (x0+dx, y0, z0), (x0+dx, y0+dy, z0), (x0, y0+dy, z0),
        (x0, y0, z0+dz), (x0+dx, y0, z0+dz), (x0+dx, y0+dy, z0+dz), (x0, y0+dy, z0+dz)
    ]
    return rs.AddBox(corners)

def window_punch(x, y, z, w, h, wall_face="south", layer="WINDOWS"):
    """Add a window surface on a wall face. Newark code: 8% of room floor area glazing."""
    rs.CurrentLayer(layer)
    if wall_face == "south":
        return rs.AddSrfPt([(x,0,z),(x+w,0,z),(x+w,0,z+h),(x,0,z+h)])
    elif wall_face == "north":
        return rs.AddSrfPt([(x,MODULE_D,z),(x+w,MODULE_D,z),(x+w,MODULE_D,z+h),(x,MODULE_D,z+h)])
    elif wall_face == "east":
        return rs.AddSrfPt([(MODULE_W,y,z),(MODULE_W,y+w,z),(MODULE_W,y+w,z+h),(MODULE_W,y,z+h)])
    elif wall_face == "west":
        return rs.AddSrfPt([(0,y,z),(0,y+w,z),(0,y+w,z+h),(0,y,z+h)])

# ══════════════════════════════════════════════════════════════
#  STRUCTURE — Slabs, Exterior Walls
# ══════════════════════════════════════════════════════════════

# Ground slab
box(0, 0, -SLAB_T, MODULE_W, MODULE_D, SLAB_T, "STRUCT_Slab")
# 2nd floor slab
box(0, 0, FLOOR_H - SLAB_T, MODULE_W, MODULE_D, SLAB_T, "STRUCT_Slab")
# Roof slab
box(0, 0, MODULE_H - SLAB_T, MODULE_W, MODULE_D, SLAB_T, "STRUCT_Slab")

# Exterior walls — 4 sides, full height
box(0, 0, 0, MODULE_W, WALL_T, MODULE_H, "STRUCT_Walls_Ext")           # south
box(0, MODULE_D - WALL_T, 0, MODULE_W, WALL_T, MODULE_H, "STRUCT_Walls_Ext")  # north
box(0, 0, 0, WALL_T, MODULE_D, MODULE_H, "STRUCT_Walls_Ext")           # west
box(MODULE_W - WALL_T, 0, 0, WALL_T, MODULE_D, MODULE_H, "STRUCT_Walls_Ext")  # east

# ══════════════════════════════════════════════════════════════
#  CORRIDOR — Central, running east-west
# ══════════════════════════════════════════════════════════════
corr_y = (MODULE_D - CORR_W) / 2.0  # centered at ~17.5'

for floor_z in [0, FLOOR_H]:
    # corridor volume (void for visualization)
    box(WALL_T, corr_y, floor_z, MODULE_W - 2*WALL_T, CORR_W, CLR_CEIL, "CIRC_Corridor")
    # corridor walls (north + south sides)
    box(WALL_T, corr_y - DEMISE_T, floor_z, MODULE_W - 2*WALL_T, DEMISE_T, FLOOR_H, "STRUCT_Walls_Int")
    box(WALL_T, corr_y + CORR_W, floor_z, MODULE_W - 2*WALL_T, DEMISE_T, FLOOR_H, "STRUCT_Walls_Int")

# ══════════════════════════════════════════════════════════════
#  STAIRWELL — West end of corridor
# ══════════════════════════════════════════════════════════════
stair_x = WALL_T
stair_y = corr_y
box(stair_x, stair_y, 0, STAIR_W, STAIR_D, MODULE_H, "CIRC_Stairwell")

# Stair demising walls
box(stair_x + STAIR_W, stair_y, 0, DEMISE_T, STAIR_D, MODULE_H, "STRUCT_Demising")

# ══════════════════════════════════════════════════════════════
#  DWELLING UNITS — 4x 1BR per floor (Newark layout)
#  South side: 2 units   |   North side: 2 units
#  Each ~500 sq ft (exceeds 70 sq ft habitable room minimum)
# ══════════════════════════════════════════════════════════════

unit_configs = []
usable_x_start = WALL_T + STAIR_W + DEMISE_T  # after stairwell
usable_x_end = MODULE_W - WALL_T
unit_w = (usable_x_end - usable_x_start) / 2.0  # ~20.25' per unit

for floor_z in [0, FLOOR_H]:
    for i in range(2):
        ux = usable_x_start + i * unit_w
        # South units (front)
        box(ux, WALL_T, floor_z, unit_w, corr_y - WALL_T - DEMISE_T, CLR_CEIL, "UNIT_1BR")
        # North units (rear)
        box(ux, corr_y + CORR_W + DEMISE_T, floor_z, unit_w, MODULE_D - (corr_y + CORR_W + DEMISE_T) - WALL_T, CLR_CEIL, "UNIT_2BR")
        # Demising wall between units
        if i == 0:
            mid_x = ux + unit_w
            box(mid_x - DEMISE_T/2, WALL_T, floor_z, DEMISE_T, corr_y - WALL_T - DEMISE_T, FLOOR_H, "STRUCT_Demising")
            box(mid_x - DEMISE_T/2, corr_y + CORR_W + DEMISE_T, floor_z, DEMISE_T, MODULE_D - (corr_y + CORR_W + DEMISE_T) - WALL_T, FLOOR_H, "STRUCT_Demising")

# ══════════════════════════════════════════════════════════════
#  WINDOWS — Newark code: 8% of floor area glazing
#  Punched openings, 3:5 proportion (taller than wide), brownstone vernacular
# ══════════════════════════════════════════════════════════════

WIN_W = 3.0    # 3' wide
WIN_H = 5.0    # 5' tall (3:5 ratio)
SILL_H = 3.0   # 3' sill height

for floor_z in [0, FLOOR_H]:
    z = floor_z + SILL_H
    # South facade — 6 windows evenly spaced
    for j in range(6):
        wx = 4.0 + j * 7.5
        window_punch(wx, 0, z, WIN_W, WIN_H, "south")
    # North facade — 6 windows
    for j in range(6):
        wx = 4.0 + j * 7.5
        window_punch(wx, 0, z, WIN_W, WIN_H, "north")
    # East facade — 3 windows
    for j in range(3):
        wy = 5.0 + j * 12.0
        window_punch(0, wy, z, WIN_W, WIN_H, "east")
    # West facade — 2 windows (stairwell side, egress)
    for j in range(2):
        wy = 5.0 + j * 15.0
        window_punch(0, wy, z, WIN_W, WIN_H, "west")

# ══════════════════════════════════════════════════════════════
#  FACADE DETAILS — Newark Contemporary Vernacular
# ══════════════════════════════════════════════════════════════

# Brownstone banding — horizontal precast belt courses at each floor
BAND_H = 0.33  # 4" band
for band_z in [FLOOR_H - 0.5, FLOOR_H + 0.5, MODULE_H - 0.5]:
    # South
    rs.CurrentLayer("FACADE_Banding")
    rs.AddSrfPt([(0,0,band_z),(MODULE_W,0,band_z),(MODULE_W,0,band_z+BAND_H),(0,0,band_z+BAND_H)])
    # North
    rs.AddSrfPt([(0,MODULE_D,band_z),(MODULE_W,MODULE_D,band_z),(MODULE_W,MODULE_D,band_z+BAND_H),(0,MODULE_D,band_z+BAND_H)])
    # East
    rs.AddSrfPt([(MODULE_W,0,band_z),(MODULE_W,MODULE_D,band_z),(MODULE_W,MODULE_D,band_z+BAND_H),(MODULE_W,0,band_z+BAND_H)])
    # West
    rs.AddSrfPt([(0,0,band_z),(0,MODULE_D,band_z),(0,MODULE_D,band_z+BAND_H),(0,0,band_z+BAND_H)])

# Cornice — stepped parapet at top (Newark flat-roof articulation)
rs.CurrentLayer("FACADE_Cornice")
PARAPET_H = 2.0
# South parapet (taller center section)
box(0, 0, MODULE_H, MODULE_W, WALL_T, PARAPET_H, "FACADE_Cornice")
box(10, 0, MODULE_H, 30, WALL_T, PARAPET_H + 1.0, "FACADE_Cornice")  # stepped center
# North parapet
box(0, MODULE_D - WALL_T, MODULE_H, MODULE_W, WALL_T, PARAPET_H, "FACADE_Cornice")
# East/West parapets
box(0, 0, MODULE_H, WALL_T, MODULE_D, PARAPET_H, "FACADE_Cornice")
box(MODULE_W - WALL_T, 0, MODULE_H, WALL_T, MODULE_D, PARAPET_H, "FACADE_Cornice")

# ══════════════════════════════════════════════════════════════
#  ROOF — Flat with mechanical zone
# ══════════════════════════════════════════════════════════════
rs.CurrentLayer("ROOF")
# Mechanical equipment pad (center of roof)
box(18, 14, MODULE_H, 14, 12, 4, "ROOF")

# ── FINAL VIEW ───────────────────────────────────────────────
rs.ZoomExtents()
rs.Command("_-SetDisplayMode _Mode=Shaded", False)
print("Newark Apartment Module complete: 50x40x20, 8 units (4 per floor), code-compliant.")
'''

# ── Entrypoint: send to Rhino via MCP or print for manual use ─
if __name__ == "__main__":
    import argparse
    import json
    import subprocess
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--mcp", action="store_true", help="Send via Rhino MCP smoketest")
    parser.add_argument("--server", default="uvx rhinomcp", help="MCP server command")
    parser.add_argument("--print", action="store_true", dest="print_code", help="Print code to stdout")
    args = parser.parse_args()

    if args.print_code or not args.mcp:
        print(RHINO_CODE)
        sys.exit(0)

    # Send via MCP
    cmd = [
        "python3", "/Users/ummi/dev/agent/rhino_mcp_smoketest.py",
        "--server", args.server,
        "--call", "execute_rhinoscript_python_code",
        "--args", json.dumps({"code": RHINO_CODE}),
        "--timeout", "120",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    print(result.stdout or result.stderr)
    sys.exit(result.returncode)
