#!/usr/bin/env python3
"""
HII Tool: Newark NJ 40x60 Residential House — Rhino Geometry Generator
========================================================================
Generates code-compliant residential geometry for a 40'x60' lot in Newark, NJ.
Uses rhino3dm for standalone geometry export (.3dm) or rhinoscriptsyntax for live Rhino.

Newark NJ Zoning (R-1/R-2 Single-Family):
  - Lot: 40ft x 60ft (12.192m x 18.288m)
  - Front setback: 25ft (7.62m)
  - Side setback: 5ft each (1.524m)
  - Rear setback: 20ft (6.096m)
  - Max height: 35ft (10.668m) / 2.5 stories
  - Max lot coverage: 40%
  - Buildable envelope: 30ft x 15ft (9.144m x 4.572m)

NJ Uniform Construction Code:
  - Min ceiling height: 7ft (2.134m), 8ft preferred
  - Min egress window: 5.7 sq ft
  - Stair width: 36in min, 7.75in max riser, 10in min tread
  - Smoke detectors per floor

Style: Newark colonial / urban rowhouse hybrid, front porch, pitched roof.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Try rhino3dm first (standalone), fall back to rhinoscriptsyntax (live Rhino)
# ---------------------------------------------------------------------------
try:
    import rhino3dm
    MODE = "rhino3dm"
except ImportError:
    try:
        import rhinoscriptsyntax as rs
        MODE = "rhinoscript"
    except ImportError:
        MODE = "export_only"
        print("[warn] Neither rhino3dm nor rhinoscriptsyntax found. Will export .py for Rhino.")


# ---------------------------------------------------------------------------
# Newark NJ Zoning & Code Constants (all in FEET, convert to model units)
# ---------------------------------------------------------------------------

@dataclass
class NewarkZoning:
    """Newark NJ R-1 Single Family Residential zone parameters."""
    lot_width: float = 40.0       # ft
    lot_depth: float = 60.0       # ft
    front_setback: float = 25.0   # ft
    side_setback: float = 5.0     # ft (each side)
    rear_setback: float = 20.0    # ft
    max_height: float = 35.0      # ft
    max_stories: float = 2.5      # stories
    max_lot_coverage: float = 0.40  # 40%

    @property
    def buildable_width(self) -> float:
        return self.lot_width - 2 * self.side_setback  # 30ft

    @property
    def buildable_depth(self) -> float:
        return self.lot_depth - self.front_setback - self.rear_setback  # 15ft

    @property
    def max_footprint(self) -> float:
        return self.lot_width * self.lot_depth * self.max_lot_coverage  # 960 sqft


@dataclass
class BuildingCode:
    """NJ Uniform Construction Code residential requirements."""
    min_ceiling_height: float = 8.0   # ft (standard)
    floor_thickness: float = 1.0      # ft (joists + subfloor)
    stair_width: float = 3.0          # ft (36in)
    max_riser: float = 0.646          # ft (7.75in)
    min_tread: float = 0.833          # ft (10in)
    egress_window_area: float = 5.7   # sq ft
    foundation_depth: float = 3.5     # ft (below frost line NJ)
    wall_thickness: float = 0.5       # ft (6in framed wall)


@dataclass
class HouseParams:
    """Derived house parameters for a Newark 40x60 lot."""
    zoning: NewarkZoning = field(default_factory=NewarkZoning)
    code: BuildingCode = field(default_factory=BuildingCode)

    # House dimensions (within buildable envelope)
    width: float = 28.0       # ft (leaving 1ft breathing room from setback)
    depth: float = 14.0       # ft (leaving 0.5ft from setback each way)
    stories: int = 2
    has_attic: bool = True     # half story
    has_basement: bool = True
    has_porch: bool = True
    porch_depth: float = 6.0  # ft
    roof_pitch: float = 8.0   # rise/12 run (8:12 pitch)

    # Style
    style: str = "colonial"   # Newark colonial with front porch

    @property
    def floor_height(self) -> float:
        return self.code.min_ceiling_height + self.code.floor_thickness  # 9ft

    @property
    def total_height(self) -> float:
        h = self.stories * self.floor_height
        if self.has_attic:
            h += (self.width / 2) * (self.roof_pitch / 12)  # gable height
        return h

    @property
    def footprint(self) -> float:
        fp = self.width * self.depth
        if self.has_porch:
            fp += self.width * self.porch_depth
        return fp

    def validate(self) -> list[str]:
        errors = []
        if self.width > self.zoning.buildable_width:
            errors.append(f"Width {self.width}ft exceeds buildable {self.zoning.buildable_width}ft")
        if self.depth > self.zoning.buildable_depth:
            errors.append(f"Depth {self.depth}ft exceeds buildable {self.zoning.buildable_depth}ft")
        if self.total_height > self.zoning.max_height:
            errors.append(f"Height {self.total_height:.1f}ft exceeds max {self.zoning.max_height}ft")
        if self.footprint > self.zoning.max_footprint:
            errors.append(f"Footprint {self.footprint:.0f}sqft exceeds max {self.zoning.max_footprint:.0f}sqft")
        return errors


# ---------------------------------------------------------------------------
# Geometry generation — rhino3dm (standalone .3dm export)
# ---------------------------------------------------------------------------

def ft_to_m(ft: float) -> float:
    """Convert feet to meters (Rhino default units)."""
    return ft * 0.3048


def generate_rhino3dm(params: HouseParams, output_path: str = "newark_house.3dm") -> str:
    """Generate full house geometry using rhino3dm and save as .3dm file."""
    model = rhino3dm.File3dm()
    model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Feet

    # Colors
    import random
    colors = {
        "Lot": (200, 220, 200),
        "Foundation": (140, 140, 140),
        "Walls-Floor1": (180, 160, 130),
        "Walls-Floor2": (180, 160, 130),
        "Attic": (170, 150, 120),
        "Roof": (100, 60, 40),
        "Porch": (160, 140, 110),
        "Porch-Roof": (110, 70, 45),
        "Windows": (180, 210, 240),
        "Door": (90, 50, 30),
        "Steps": (160, 160, 160),
        "Chimney": (120, 80, 60),
    }

    # Create layers
    for name, (r, g, b) in colors.items():
        layer = rhino3dm.Layer()
        layer.Name = name
        layer.Color = (r, g, b, 255)
        model.Layers.Add(layer)

    def layer_idx(name):
        for i in range(len(model.Layers)):
            if model.Layers[i].Name == name:
                return i
        return 0

    def add_box(layer_name, x0, y0, z0, x1, y1, z1):
        """Add an axis-aligned box as a Brep."""
        corners = [
            rhino3dm.Point3d(x0, y0, z0), rhino3dm.Point3d(x1, y0, z0),
            rhino3dm.Point3d(x1, y1, z0), rhino3dm.Point3d(x0, y1, z0),
            rhino3dm.Point3d(x0, y0, z1), rhino3dm.Point3d(x1, y0, z1),
            rhino3dm.Point3d(x1, y1, z1), rhino3dm.Point3d(x0, y1, z1),
        ]
        box = rhino3dm.BoundingBox(corners[0], corners[6])
        brep = rhino3dm.Brep.CreateFromBox(box)
        if brep:
            attr = rhino3dm.ObjectAttributes()
            attr.LayerIndex = layer_idx(layer_name)
            model.Objects.AddBrep(brep, attr)
        return brep

    def add_mesh_box(layer_name, x0, y0, z0, x1, y1, z1):
        """Add box as mesh (fallback if Brep.CreateFromBox unavailable)."""
        mesh = rhino3dm.Mesh()
        # 8 vertices of a box
        verts = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]
        for v in verts:
            mesh.Vertices.Add(v[0], v[1], v[2])
        # 6 faces (2 triangles each = 12 triangles)
        faces = [
            (0,1,2,3), (4,7,6,5),  # bottom, top
            (0,4,5,1), (2,6,7,3),  # front, back
            (0,3,7,4), (1,5,6,2),  # left, right
        ]
        for f in faces:
            mesh.Faces.AddFace(f[0], f[1], f[2], f[3])
        mesh.Normals.ComputeNormals()
        mesh.Compact()
        attr = rhino3dm.ObjectAttributes()
        attr.LayerIndex = layer_idx(layer_name)
        model.Objects.AddMesh(mesh, attr)
        return mesh

    # Use mesh boxes (more reliable across rhino3dm versions)
    box = add_mesh_box

    z = params.zoning
    c = params.code
    p = params

    # Lot origin at (0,0,0), house positioned per setbacks
    lot_w, lot_d = z.lot_width, z.lot_depth
    hx = z.side_setback + (z.buildable_width - p.width) / 2  # center in buildable
    hy = z.front_setback  # front setback

    # --- LOT ---
    box("Lot", 0, 0, -0.1, lot_w, lot_d, 0)

    # --- FOUNDATION ---
    box("Foundation", hx, hy, -c.foundation_depth, hx + p.width, hy + p.depth, 0)

    # --- FIRST FLOOR WALLS ---
    fh = p.floor_height
    wt = c.wall_thickness
    # Outer shell
    box("Walls-Floor1", hx, hy, 0, hx + p.width, hy + p.depth, fh)
    # Hollow out interior (slightly smaller box on same layer — visual only)

    # --- SECOND FLOOR WALLS ---
    box("Walls-Floor2", hx, hy, fh, hx + p.width, hy + p.depth, 2 * fh)

    # --- PORCH ---
    if p.has_porch:
        porch_y = hy - p.porch_depth  # extends toward street
        if porch_y < 0:
            porch_y = 0
        # Porch deck (raised 2.5ft)
        box("Porch", hx, porch_y, 2.0, hx + p.width, hy, 2.5)
        # Porch columns (4 columns)
        col_w = 0.5
        porch_h = fh - 0.5
        for cx in [hx + 1, hx + p.width/3, hx + 2*p.width/3, hx + p.width - 1.5]:
            box("Porch", cx, porch_y, 2.5, cx + col_w, porch_y + col_w, 2.5 + porch_h)
        # Porch roof
        box("Porch-Roof", hx - 0.5, porch_y - 0.5, 2.5 + porch_h, hx + p.width + 0.5, hy + 0.5, 2.5 + porch_h + 0.5)

    # --- STEPS ---
    step_w = 5.0
    step_d = 1.0
    step_h = 0.5
    step_x = hx + p.width / 2 - step_w / 2
    for i in range(4):
        sy = (hy - p.porch_depth) - (i + 1) * step_d
        if sy < 0:
            sy = 0
        box("Steps", step_x, sy, 2.0 - (i + 1) * step_h, step_x + step_w, sy + step_d, 2.0 - i * step_h)

    # --- ROOF (Gable) ---
    ridge_h = 2 * fh + (p.width / 2) * (p.roof_pitch / 12)
    # Approximate gable roof as two sloped boxes (simplified)
    # Left slope
    roof_mesh = rhino3dm.Mesh()
    rx0, rx1 = hx - 0.5, hx + p.width + 0.5
    ry0, ry1 = hy - 0.5, hy + p.depth + 0.5
    rz_base = 2 * fh
    rz_ridge = ridge_h
    rmid_x = (rx0 + rx1) / 2

    # Vertices: 6 points of a prism (gable)
    roof_verts = [
        (rx0, ry0, rz_base), (rx1, ry0, rz_base),    # front bottom L, R
        (rx0, ry1, rz_base), (rx1, ry1, rz_base),    # back bottom L, R
        (rmid_x, ry0, rz_ridge), (rmid_x, ry1, rz_ridge),  # front/back ridge
    ]
    for v in roof_verts:
        roof_mesh.Vertices.Add(v[0], v[1], v[2])

    # Faces
    roof_faces = [
        (0, 2, 5, 4),  # left slope
        (1, 4, 5, 3),  # right slope
        (0, 4, 1),      # front gable triangle
        (2, 3, 5),      # rear gable triangle
    ]
    for f in roof_faces:
        if len(f) == 4:
            roof_mesh.Faces.AddFace(f[0], f[1], f[2], f[3])
        else:
            roof_mesh.Faces.AddFace(f[0], f[1], f[2])

    roof_mesh.Normals.ComputeNormals()
    roof_mesh.Compact()
    attr = rhino3dm.ObjectAttributes()
    attr.LayerIndex = layer_idx("Roof")
    model.Objects.AddMesh(roof_mesh, attr)

    # --- WINDOWS ---
    win_w, win_h = 3.0, 4.5
    win_sill = 3.0  # sill height from floor

    # Front windows — Floor 1
    for floor_z in [0, fh]:
        for wx in [hx + 3, hx + p.width/2 - win_w/2, hx + p.width - 3 - win_w]:
            box("Windows",
                wx, hy - 0.1, floor_z + win_sill,
                wx + win_w, hy + 0.1, floor_z + win_sill + win_h)

    # Side windows (2 per floor per side)
    for floor_z in [0, fh]:
        for wy in [hy + 3, hy + p.depth - 3 - win_w]:
            # Left side
            box("Windows",
                hx - 0.1, wy, floor_z + win_sill,
                hx + 0.1, wy + win_w, floor_z + win_sill + win_h)
            # Right side
            box("Windows",
                hx + p.width - 0.1, wy, floor_z + win_sill,
                hx + p.width + 0.1, wy + win_w, floor_z + win_sill + win_h)

    # Attic window (front, centered)
    attic_win_w, attic_win_h = 2.5, 3.0
    ax = hx + p.width / 2 - attic_win_w / 2
    box("Windows", ax, hy - 0.1, 2 * fh + 2, ax + attic_win_w, hy + 0.1, 2 * fh + 2 + attic_win_h)

    # --- FRONT DOOR ---
    door_w, door_h = 3.5, 7.0
    dx = hx + p.width / 2 - door_w / 2
    box("Door", dx, hy - 0.1, 0, dx + door_w, hy + 0.1, door_h)

    # --- CHIMNEY ---
    chim_w = 2.5
    box("Chimney",
        hx + p.width - 4, hy + p.depth / 2 - chim_w / 2, fh,
        hx + p.width - 4 + chim_w, hy + p.depth / 2 + chim_w / 2, ridge_h + 3)

    # --- SAVE ---
    model.Write(output_path, 7)  # version 7 = Rhino 7 format
    print(f"[rhino3dm] Saved {output_path}")
    print(f"  Lot: {lot_w}ft x {lot_d}ft")
    print(f"  House: {p.width}ft x {p.depth}ft, {p.stories} stories + attic")
    print(f"  Footprint: {p.footprint:.0f} sqft (max {z.max_footprint:.0f})")
    print(f"  Height: {p.total_height:.1f}ft (max {z.max_height}ft)")
    print(f"  Layers: {len(model.Layers)}")
    print(f"  Objects: {len(model.Objects)}")
    return output_path


# ---------------------------------------------------------------------------
# Geometry generation — RhinoScript Python (for live Rhino via MCP)
# ---------------------------------------------------------------------------

def generate_rhinoscript(params: HouseParams) -> str:
    """Generate RhinoScript Python code string for execution in Rhino."""
    z = params.zoning
    c = params.code
    p = params
    fh = p.floor_height
    wt = c.wall_thickness

    hx = z.side_setback + (z.buildable_width - p.width) / 2
    hy = z.front_setback
    ridge_h = 2 * fh + (p.width / 2) * (p.roof_pitch / 12)

    code = f'''import rhinoscriptsyntax as rs
import Rhino

# Newark NJ 40x60 Residential House — Code Compliant
# Zoning: R-1, Setbacks F:{z.front_setback}' S:{z.side_setback}' R:{z.rear_setback}'
# House: {p.width}' x {p.depth}', {p.stories} stories + attic

rs.UnitSystem(8)  # Feet

# --- Layers ---
layers = {{
    "Lot": (200,220,200), "Foundation": (140,140,140),
    "Walls-Floor1": (180,160,130), "Walls-Floor2": (180,160,130),
    "Roof": (100,60,40), "Porch": (160,140,110), "Porch-Roof": (110,70,45),
    "Windows": (180,210,240), "Door": (90,50,30),
    "Steps": (160,160,160), "Chimney": (120,80,60),
}}
for name, color in layers.items():
    if not rs.IsLayer(name):
        rs.AddLayer(name, color)

def box(layer, corners):
    rs.CurrentLayer(layer)
    return rs.AddBox(corners)

hx, hy = {hx}, {hy}
w, d = {p.width}, {p.depth}
fh = {fh}

# LOT
rs.CurrentLayer("Lot")
rs.AddBox(rs.BoundingBox([
    (0,0,-0.1), ({z.lot_width},{z.lot_depth},0)
]))

# FOUNDATION
rs.CurrentLayer("Foundation")
rs.AddBox(rs.BoundingBox([
    (hx, hy, -{c.foundation_depth}), (hx+w, hy+d, 0)
]))

# WALLS
for i, layer in enumerate(["Walls-Floor1", "Walls-Floor2"]):
    z0 = i * fh
    rs.CurrentLayer(layer)
    rs.AddBox(rs.BoundingBox([
        (hx, hy, z0), (hx+w, hy+d, z0+fh)
    ]))

# PORCH
porch_y = hy - {p.porch_depth}
if porch_y < 0: porch_y = 0
rs.CurrentLayer("Porch")
rs.AddBox(rs.BoundingBox([(hx, porch_y, 2.0), (hx+w, hy, 2.5)]))
col_w = 0.5
for cx in [hx+1, hx+w/3, hx+2*w/3, hx+w-1.5]:
    rs.AddBox(rs.BoundingBox([
        (cx, porch_y, 2.5), (cx+col_w, porch_y+col_w, 2.5+fh-0.5)
    ]))

# PORCH ROOF
rs.CurrentLayer("Porch-Roof")
rs.AddBox(rs.BoundingBox([
    (hx-0.5, porch_y-0.5, 2.5+fh-0.5),
    (hx+w+0.5, hy+0.5, 2.5+fh)
]))

# STEPS
rs.CurrentLayer("Steps")
step_w, step_d, step_h = 5.0, 1.0, 0.5
sx = hx + w/2 - step_w/2
for i in range(4):
    sy = porch_y - (i+1)*step_d
    if sy < 0: sy = 0
    rs.AddBox(rs.BoundingBox([
        (sx, sy, 2.0-(i+1)*step_h), (sx+step_w, sy+step_d, 2.0-i*step_h)
    ]))

# ROOF (Gable as mesh)
ridge = {ridge_h}
rx0, rx1 = hx-0.5, hx+w+0.5
ry0, ry1 = hy-0.5, hy+d+0.5
rmid = (rx0+rx1)/2
rz = 2*fh

rs.CurrentLayer("Roof")
pts = [
    (rx0,ry0,rz), (rx1,ry0,rz), (rx0,ry1,rz), (rx1,ry1,rz),
    (rmid,ry0,ridge), (rmid,ry1,ridge),
]
mesh = Rhino.Geometry.Mesh()
for p in pts:
    mesh.Vertices.Add(p[0], p[1], p[2])
mesh.Faces.AddFace(0, 2, 5, 4)  # left slope
mesh.Faces.AddFace(1, 4, 5, 3)  # right slope
mesh.Faces.AddFace(0, 4, 1)      # front gable
mesh.Faces.AddFace(2, 3, 5)      # rear gable
mesh.Normals.ComputeNormals()
rs.ObjectLayer(rs.coerceguid(Rhino.RhinoDoc.ActiveDoc.Objects.AddMesh(mesh)), "Roof")

# WINDOWS
rs.CurrentLayer("Windows")
win_w, win_h, sill = 3.0, 4.5, 3.0
for fz in [0, fh]:
    for wx in [hx+3, hx+w/2-win_w/2, hx+w-3-win_w]:
        rs.AddBox(rs.BoundingBox([
            (wx, hy-0.1, fz+sill), (wx+win_w, hy+0.1, fz+sill+win_h)
        ]))
    for wy in [hy+3, hy+d-6]:
        rs.AddBox(rs.BoundingBox([(hx-0.1,wy,fz+sill),(hx+0.1,wy+win_w,fz+sill+win_h)]))
        rs.AddBox(rs.BoundingBox([(hx+w-0.1,wy,fz+sill),(hx+w+0.1,wy+win_w,fz+sill+win_h)]))

# ATTIC WINDOW
attic_ww, attic_wh = 2.5, 3.0
ax = hx + w/2 - attic_ww/2
rs.AddBox(rs.BoundingBox([(ax,hy-0.1,2*fh+2),(ax+attic_ww,hy+0.1,2*fh+2+attic_wh)]))

# FRONT DOOR
rs.CurrentLayer("Door")
dw, dh = 3.5, 7.0
dx = hx + w/2 - dw/2
rs.AddBox(rs.BoundingBox([(dx,hy-0.1,0),(dx+dw,hy+0.1,dh)]))

# CHIMNEY
rs.CurrentLayer("Chimney")
chw = 2.5
rs.AddBox(rs.BoundingBox([
    (hx+w-4, hy+d/2-chw/2, fh),
    (hx+w-4+chw, hy+d/2+chw/2, ridge+3)
]))

rs.ZoomExtents()
print("Newark NJ 40x60 house created successfully")
print(f"  House: {{w}}ft x {{d}}ft, 2 stories + attic")
print(f"  Height to ridge: {{ridge:.1f}}ft")
'''
    return code


# ---------------------------------------------------------------------------
# Floor plan iterations — parametric variations
# ---------------------------------------------------------------------------

FLOOR_PLANS = {
    "colonial": {
        "description": "Classic Newark colonial — center hall, 2 stories + attic",
        "rooms_floor1": [
            {"name": "Living Room", "x": 0, "y": 0, "w": 14, "d": 14},
            {"name": "Kitchen/Dining", "x": 14, "y": 0, "w": 14, "d": 14},
        ],
        "rooms_floor2": [
            {"name": "Master Bedroom", "x": 0, "y": 0, "w": 14, "d": 14},
            {"name": "Bedroom 2", "x": 14, "y": 0, "w": 8, "d": 10},
            {"name": "Bedroom 3", "x": 14, "y": 10, "w": 8, "d": 4},
            {"name": "Bathroom", "x": 22, "y": 0, "w": 6, "d": 14},
        ],
    },
    "open_plan": {
        "description": "Modern open floor plan with rear kitchen",
        "rooms_floor1": [
            {"name": "Open Living/Dining", "x": 0, "y": 0, "w": 20, "d": 14},
            {"name": "Kitchen", "x": 20, "y": 0, "w": 8, "d": 10},
            {"name": "Half Bath", "x": 20, "y": 10, "w": 8, "d": 4},
        ],
        "rooms_floor2": [
            {"name": "Master Suite", "x": 0, "y": 0, "w": 14, "d": 14},
            {"name": "Bedroom 2", "x": 14, "y": 0, "w": 14, "d": 7},
            {"name": "Bedroom 3", "x": 14, "y": 7, "w": 8, "d": 7},
            {"name": "Full Bath", "x": 22, "y": 7, "w": 6, "d": 7},
        ],
    },
}


def generate_iterations(n: int = 5, output_dir: str = "iterations") -> list[str]:
    """Generate parametric variations of the house design."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    variations = []
    base = HouseParams()

    configs = [
        # (name, width, depth, stories, porch, pitch, style)
        ("colonial_28x14", 28, 14, 2, True, 8, "colonial"),
        ("colonial_26x15", 26, 15, 2, True, 10, "colonial"),
        ("narrow_24x14", 24, 14, 2, True, 8, "colonial"),
        ("wide_30x13", 30, 13, 2, True, 6, "open_plan"),
        ("tall_26x14", 26, 14, 2, True, 12, "colonial"),
    ]

    for i, (name, w, d, stories, porch, pitch, style) in enumerate(configs[:n]):
        p = HouseParams(
            width=w, depth=d, stories=stories,
            has_porch=porch, roof_pitch=pitch, style=style,
        )
        errors = p.validate()
        if errors:
            print(f"[skip] {name}: {errors}")
            continue

        if MODE == "rhino3dm":
            fpath = str(out / f"{name}.3dm")
            generate_rhino3dm(p, fpath)
        else:
            code = generate_rhinoscript(p)
            fpath = str(out / f"{name}.py")
            Path(fpath).write_text(code)
            print(f"[export] {fpath}")

        variations.append(fpath)

    return variations


# ---------------------------------------------------------------------------
# ComfyUI render workflow
# ---------------------------------------------------------------------------

def comfyui_render_workflow(
    image_path: Optional[str] = None,
    prompt: str = "",
    style: str = "architectural",
) -> dict:
    """Build a ComfyUI workflow for rendering the house design."""
    if not prompt:
        prompt = (
            "photorealistic architectural rendering, Newark New Jersey colonial house, "
            "brick and vinyl siding, front porch with columns, pitched gable roof, "
            "residential neighborhood, golden hour lighting, landscaped front yard, "
            "sidewalk, mature trees, high detail, 8k"
        )

    neg = (
        "cartoon, anime, sketch, wireframe, low quality, blurry, "
        "deformed, ugly, watermark, text, oversaturated"
    )

    if image_path:
        # img2img from viewport capture
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}},
            "2": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": prompt, "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": neg, "clip": ["1", 1]}},
            "8": {"class_type": "LoadImage",
                  "inputs": {"image": image_path}},
            "9": {"class_type": "VAEEncode",
                  "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}},
            "5": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 42, "steps": 30, "cfg": 7.5,
                    "sampler_name": "euler_ancestral", "scheduler": "normal",
                    "denoise": 0.55,
                    "model": ["1", 0], "positive": ["2", 0],
                    "negative": ["3", 0], "latent_image": ["9", 0],
                },
            },
            "6": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
            "7": {"class_type": "SaveImage",
                  "inputs": {"filename_prefix": "newark_house", "images": ["6", 0]}},
        }
    else:
        # txt2img
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}},
            "2": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": prompt, "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": neg, "clip": ["1", 1]}},
            "4": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 1216, "height": 832, "batch_size": 1}},
            "5": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 42, "steps": 30, "cfg": 7.5,
                    "sampler_name": "euler_ancestral", "scheduler": "normal",
                    "denoise": 1.0,
                    "model": ["1", 0], "positive": ["2", 0],
                    "negative": ["3", 0], "latent_image": ["4", 0],
                },
            },
            "6": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
            "7": {"class_type": "SaveImage",
                  "inputs": {"filename_prefix": "newark_house", "images": ["6", 0]}},
        }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Newark NJ 40x60 Residential House Generator")
    parser.add_argument("--output", "-o", default="newark_house.3dm", help="Output file path")
    parser.add_argument("--rhinoscript", action="store_true", help="Output RhinoScript Python instead of .3dm")
    parser.add_argument("--iterations", "-n", type=int, default=0, help="Generate N parametric variations")
    parser.add_argument("--iter-dir", default="iterations", help="Directory for iterations output")
    parser.add_argument("--comfyui-workflow", action="store_true", help="Output ComfyUI render workflow JSON")
    parser.add_argument("--comfyui-image", type=str, help="Input image for img2img rendering")
    parser.add_argument("--width", type=float, default=28.0, help="House width in feet")
    parser.add_argument("--depth", type=float, default=14.0, help="House depth in feet")
    parser.add_argument("--pitch", type=float, default=8.0, help="Roof pitch (rise per 12 run)")
    parser.add_argument("--no-porch", action="store_true", help="Omit front porch")
    parser.add_argument("--validate-only", action="store_true", help="Only validate zoning compliance")
    args = parser.parse_args()

    params = HouseParams(
        width=args.width,
        depth=args.depth,
        roof_pitch=args.pitch,
        has_porch=not args.no_porch,
    )

    # Validate
    errors = params.validate()
    if errors:
        print("ZONING VIOLATIONS:")
        for e in errors:
            print(f"  ✗ {e}")
        return 1

    print("Zoning compliance: PASS")
    print(f"  Lot: {params.zoning.lot_width}' x {params.zoning.lot_depth}'")
    print(f"  House: {params.width}' x {params.depth}', {params.stories} stories + attic")
    print(f"  Footprint: {params.footprint:.0f} sqft / {params.zoning.max_footprint:.0f} max")
    print(f"  Height: {params.total_height:.1f}' / {params.zoning.max_height}'")

    if args.validate_only:
        return 0

    # Generate iterations
    if args.iterations > 0:
        files = generate_iterations(args.iterations, args.iter_dir)
        print(f"\nGenerated {len(files)} variations in {args.iter_dir}/")
        return 0

    # ComfyUI workflow
    if args.comfyui_workflow:
        wf = comfyui_render_workflow(image_path=args.comfyui_image)
        out = args.output.replace(".3dm", "_comfyui.json")
        Path(out).write_text(json.dumps(wf, indent=2))
        print(f"ComfyUI workflow saved to {out}")
        return 0

    # Generate geometry
    if args.rhinoscript or MODE == "rhinoscript":
        code = generate_rhinoscript(params)
        out = args.output.replace(".3dm", ".py")
        Path(out).write_text(code)
        print(f"RhinoScript Python saved to {out}")
    elif MODE == "rhino3dm":
        generate_rhino3dm(params, args.output)
    else:
        code = generate_rhinoscript(params)
        out = args.output.replace(".3dm", ".py")
        Path(out).write_text(code)
        print(f"RhinoScript Python saved to {out} (install rhino3dm for .3dm export)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
