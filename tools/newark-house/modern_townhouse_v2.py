#!/usr/bin/env python3
"""
Transform the active Rhino document into a modern narrow-lot townhouse iteration.

This version moves the model closer to the user's facade reference:
- three-level urban infill massing
- street-facing garage
- offset stoop and entry
- larger punched glazing
- sharper interior organization around a vertical stair core
"""

import rhinoscriptsyntax as rs
import Rhino
import System.Drawing


FT = 304.8


def ensure_layer(name, rgb):
    if not rs.IsLayer(name):
        rs.AddLayer(name, System.Drawing.Color.FromArgb(*rgb))


def delete_layer_objects(prefixes):
    for name in rs.LayerNames() or []:
        if any(name.startswith(prefix) for prefix in prefixes):
            ids = rs.ObjectsByLayer(name) or []
            if ids:
                rs.DeleteObjects(ids)


def box(layer, x0, y0, z0, x1, y1, z1):
    rs.CurrentLayer(layer)
    return rs.AddBox([
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y1, z0),
        (x0, y1, z0),
        (x0, y0, z1),
        (x1, y0, z1),
        (x1, y1, z1),
        (x0, y1, z1),
    ])


def polyline(layer, pts):
    rs.CurrentLayer(layer)
    return rs.AddPolyline(pts)


def add_mesh(layer, vertices, faces):
    rs.CurrentLayer(layer)
    mesh = Rhino.Geometry.Mesh()
    for vx, vy, vz in vertices:
        mesh.Vertices.Add(vx, vy, vz)
    for face in faces:
        mesh.Faces.AddFace(*face)
    mesh.Normals.ComputeNormals()
    mesh.Compact()
    guid = Rhino.RhinoDoc.ActiveDoc.Objects.AddMesh(mesh)
    rs.ObjectLayer(guid, layer)
    return guid


layers = {
    "Townhouse-Shell": (225, 225, 225),
    "Townhouse-Core": (210, 205, 195),
    "Townhouse-FrontFrame": (95, 70, 55),
    "Townhouse-Glass": (145, 205, 235),
    "Townhouse-Garage": (55, 55, 60),
    "Townhouse-Stoop": (160, 145, 130),
    "Townhouse-Rail": (35, 35, 35),
    "Interior-Floorplates": (205, 205, 205),
    "Interior-Stairs": (175, 140, 100),
    "Interior-Walls": (237, 229, 220),
    "Interior-Glass": (160, 215, 240),
    "Interior-Fixtures": (120, 160, 205),
    "Interior-Furniture": (188, 150, 112),
    "Interior-Annotations": (80, 80, 80),
    "Interior-Plan": (110, 110, 110),
}
for name, rgb in layers.items():
    ensure_layer(name, rgb)


# Clear prior shell/interior iteration geometry while preserving lot context.
delete_layer_objects(["Townhouse-", "Interior-", "Foundation", "Walls-", "Attic", "Roof", "Porch", "Door", "Windows", "Steps", "Chimney"])


# Site and envelope
lot_w = 40 * FT
front_set = 25 * FT
side_set = 5 * FT
buildable_w = 30 * FT

house_w = 18 * FT
house_d = 36 * FT
hx = side_set + (buildable_w - house_w) / 2
hy = front_set

level_h = 10 * FT
parapet_h = 2.5 * FT
total_h = 3 * level_h + parapet_h
wall_t = 0.5 * FT


# Main shell
box("Townhouse-Shell", hx, hy, 0, hx + house_w, hy + house_d, total_h)

# Rear notch / light terrace feel at top floor
box("Townhouse-Shell", hx + 2.5 * FT, hy + house_d - 9 * FT, 2 * level_h, hx + house_w - 2.5 * FT, hy + house_d, 3 * level_h)

# Street facade composition
front_y0 = hy - 0.25 * FT
front_y1 = hy + 0.25 * FT

# Left garage bay
garage_x0 = hx + 1.0 * FT
garage_x1 = garage_x0 + 8.5 * FT
garage_h = 8.0 * FT
box("Townhouse-Garage", garage_x0, front_y0, 0, garage_x1, front_y1, garage_h)

# Right stoop/entry tower
entry_x0 = hx + 11.5 * FT
entry_x1 = hx + house_w - 1.0 * FT
box("Townhouse-FrontFrame", entry_x0, front_y0, 0, entry_x1, front_y1, 1.0 * FT)

# Stoop and stair to raised entry
step_w = entry_x1 - entry_x0
for i in range(7):
    z0 = i * 0.5 * FT
    z1 = z0 + 0.5 * FT
    y0 = hy - (7 - i) * 1.0 * FT
    y1 = y0 + 1.0 * FT
    box("Townhouse-Stoop", entry_x0, y0, z0, entry_x1, y1, z1)

landing_z = 3.5 * FT
box("Townhouse-Stoop", entry_x0, hy - 1.5 * FT, landing_z - 0.4 * FT, entry_x1, hy + 1.5 * FT, landing_z)

# Railings
rail_x0 = entry_x0 - 0.25 * FT
rail_x1 = entry_x0
box("Townhouse-Rail", rail_x0, hy - 7 * FT, 0, rail_x1, hy + 1.5 * FT, 3.8 * FT)
box("Townhouse-Rail", entry_x1, hy - 7 * FT, 0, entry_x1 + 0.25 * FT, hy + 1.5 * FT, 3.8 * FT)

# Tall front frame around upper glazing
box("Townhouse-FrontFrame", hx + 0.6 * FT, front_y0, 8.6 * FT, hx + house_w - 0.6 * FT, front_y1, total_h - 0.6 * FT)

# Large upper windows
window_sets = [
    (hx + 1.6 * FT, 10.0 * FT, hx + house_w - 1.6 * FT, 17.0 * FT),
    (hx + 1.6 * FT, 20.0 * FT, hx + house_w - 1.6 * FT, 27.5 * FT),
]
for x0, z0, x1, z1 in window_sets:
    box("Townhouse-Glass", x0, front_y0 - 0.1 * FT, z0, x1, front_y1 + 0.1 * FT, z1)

# Entry sidelight and door
box("Townhouse-Glass", entry_x0 + 0.5 * FT, front_y0 - 0.1 * FT, 4.0 * FT, entry_x1 - 2.1 * FT, front_y1 + 0.1 * FT, 9.0 * FT)
box("Townhouse-FrontFrame", entry_x1 - 1.8 * FT, front_y0 - 0.1 * FT, 3.5 * FT, entry_x1 - 0.6 * FT, front_y1 + 0.1 * FT, 8.2 * FT)

# Side window cuts to bring light into the stair and living zones
for z0, z1, y0, y1 in [
    (4.0 * FT, 9.0 * FT, hy + 4.0 * FT, hy + 10.0 * FT),
    (13.0 * FT, 20.0 * FT, hy + 12.0 * FT, hy + 21.0 * FT),
    (23.0 * FT, 29.0 * FT, hy + 22.0 * FT, hy + 31.0 * FT),
]:
    box("Townhouse-Glass", hx + house_w - 0.2 * FT, y0, z0, hx + house_w + 0.2 * FT, y1, z1)


# Interior plates
for z in [0, level_h, 2 * level_h, 3 * level_h]:
    if z < 3 * level_h:
        box("Interior-Floorplates", hx + wall_t, hy + wall_t, z - 0.35 * FT, hx + house_w - wall_t, hy + house_d - wall_t, z)


# Stair core on the right side
core_x0 = hx + house_w - 5.0 * FT
core_x1 = hx + house_w - wall_t
core_y0 = hy + 3.0 * FT
core_y1 = hy + 21.0 * FT
box("Townhouse-Core", core_x0, core_y0, 0, core_x1, core_y1, 3 * level_h)

stair_w = core_x1 - core_x0 - 0.8 * FT
stair_x0 = core_x0 + 0.4 * FT
stair_x1 = stair_x0 + stair_w
tread_d = 11.0 * 25.4
riser_h = 7.0 * 25.4
landing_d = 3.0 * FT


def add_stair_flight(base_z, start_y, direction):
    for i in range(9):
        z0 = base_z + i * riser_h
        z1 = z0 + riser_h
        if direction > 0:
            y0 = start_y + i * tread_d
        else:
            y0 = start_y + (8 - i) * tread_d
        y1 = y0 + tread_d
        box("Interior-Stairs", stair_x0, y0, z0, stair_x1, y1, z1)


run_y = core_y0 + 0.8 * FT
run_len = 9 * tread_d
for level_base in [0, level_h, 2 * level_h]:
    add_stair_flight(level_base, run_y, 1)
    box("Interior-Stairs", stair_x0, run_y + run_len, level_base + 9 * riser_h, stair_x1, run_y + run_len + landing_d, level_base + 9 * riser_h + 0.3 * FT)
    add_stair_flight(level_base + 9 * riser_h + 0.3 * FT, run_y, -1)


# Plan logic
hall_x0 = core_x0 - 3.0 * FT
hall_x1 = core_x0
powder_y0 = hy + 12.5 * FT
powder_y1 = hy + 18.0 * FT
mech_y0 = hy + 18.5 * FT
mech_y1 = hy + 24.0 * FT

# Floor 1: garage + foyer + powder + mech/laundry + rear flex
z1 = 0
garage_part_x = hx + 8.75 * FT
rear_room_y = hy + 24.5 * FT
for args in [
    (garage_part_x, hy + wall_t, z1, garage_part_x + wall_t, hy + 14.5 * FT, z1 + level_h),
    (hall_x0, hy + wall_t, z1, hall_x1, hy + house_d - wall_t, z1 + level_h),
    (garage_part_x, hy + 14.5 * FT, z1, hall_x0, hy + 15.0 * FT, z1 + level_h),
    (garage_part_x, powder_y0, z1, hall_x0, powder_y0 + wall_t, z1 + level_h),
    (garage_part_x, powder_y1, z1, hall_x0, powder_y1 + wall_t, z1 + level_h),
    (garage_part_x, mech_y0, z1, hall_x0, mech_y0 + wall_t, z1 + level_h),
    (garage_part_x, rear_room_y, z1, hall_x0, rear_room_y + wall_t, z1 + level_h),
]:
    box("Interior-Walls", *args)

box("Interior-Furniture", hx + wall_t + 0.25 * FT, hy + wall_t + 0.25 * FT, z1, garage_part_x - 0.2 * FT, hy + 14.3 * FT, z1 + 7.5 * FT)
box("Interior-Fixtures", garage_part_x + 0.6 * FT, powder_y0 + 0.5 * FT, z1, hall_x0 - 0.6 * FT, powder_y1 - 0.5 * FT, z1 + 2.8 * FT)
box("Interior-Fixtures", garage_part_x + 0.6 * FT, mech_y0 + 0.5 * FT, z1, hall_x0 - 0.6 * FT, mech_y1 - 0.6 * FT, z1 + 3.0 * FT)
box("Interior-Furniture", hx + 1.5 * FT, rear_room_y + 0.8 * FT, z1, hall_x0 - 0.8 * FT, hy + house_d - 1.5 * FT, z1 + 2.6 * FT)

# Floor 2: kitchen front + dining middle + living rear, with aligned powder stack
z2 = level_h
kitchen_y1 = hy + 11.0 * FT
dining_y1 = hy + 20.0 * FT
for args in [
    (hall_x0, hy + wall_t, z2, hall_x1, hy + house_d - wall_t, z2 + level_h),
    (hx + wall_t, kitchen_y1, z2, hall_x0, kitchen_y1 + wall_t, z2 + level_h),
    (hx + wall_t, dining_y1, z2, hall_x0, dining_y1 + wall_t, z2 + level_h),
    (garage_part_x, powder_y0, z2, hall_x0, powder_y0 + wall_t, z2 + level_h),
    (garage_part_x, powder_y1, z2, hall_x0, powder_y1 + wall_t, z2 + level_h),
]:
    box("Interior-Walls", *args)

box("Interior-Furniture", hx + 1.2 * FT, hy + 1.2 * FT, z2, hall_x0 - 0.8 * FT, hy + 4.0 * FT, z2 + 3.0 * FT)
box("Interior-Furniture", hx + 4.5 * FT, hy + 5.0 * FT, z2, hall_x0 - 1.5 * FT, hy + 8.5 * FT, z2 + 2.8 * FT)
box("Interior-Furniture", hx + 3.0 * FT, hy + 12.5 * FT, z2, hall_x0 - 1.8 * FT, hy + 17.5 * FT, z2 + 2.4 * FT)
box("Interior-Furniture", hx + 2.0 * FT, hy + 23.0 * FT, z2, hall_x0 - 0.8 * FT, hy + 30.5 * FT, z2 + 1.8 * FT)
box("Interior-Fixtures", garage_part_x + 0.6 * FT, powder_y0 + 0.5 * FT, z2, hall_x0 - 0.6 * FT, powder_y1 - 0.5 * FT, z2 + 2.8 * FT)
box("Interior-Glass", hall_x0 - 0.15 * FT, hy + 20.5 * FT, z2, hall_x0, hy + 33.0 * FT, z2 + 4.0 * FT)

# Floor 3: front bedroom + middle bath/laundry stack + rear primary suite
z3 = 2 * level_h
bed_split_y = hy + 15.5 * FT
closet_split_y = hy + 24.0 * FT
for args in [
    (hall_x0, hy + wall_t, z3, hall_x1, hy + house_d - wall_t, z3 + level_h),
    (hx + wall_t, bed_split_y, z3, hall_x0, bed_split_y + wall_t, z3 + level_h),
    (garage_part_x, hy + 8.5 * FT, z3, hall_x0, hy + 9.0 * FT, z3 + level_h),
    (garage_part_x, closet_split_y, z3, hall_x0, closet_split_y + wall_t, z3 + level_h),
]:
    box("Interior-Walls", *args)

box("Interior-Fixtures", garage_part_x + 0.6 * FT, hy + 9.2 * FT, z3, hall_x0 - 0.6 * FT, hy + 15.0 * FT, z3 + 2.8 * FT)
box("Interior-Fixtures", garage_part_x + 0.6 * FT, hy + 15.8 * FT, z3, hall_x0 - 0.6 * FT, hy + 18.5 * FT, z3 + 2.8 * FT)
box("Interior-Furniture", hx + 1.5 * FT, hy + 2.0 * FT, z3, garage_part_x - 0.8 * FT, hy + 11.5 * FT, z3 + 2.2 * FT)
box("Interior-Furniture", hx + 1.5 * FT, hy + 20.0 * FT, z3, garage_part_x - 0.8 * FT, hy + 31.0 * FT, z3 + 2.2 * FT)
box("Interior-Furniture", garage_part_x + 0.8 * FT, hy + 25.0 * FT, z3, hall_x0 - 0.8 * FT, hy + 33.0 * FT, z3 + 2.2 * FT)

# Plan outlines at each level for readability
for z in [0.1 * FT, z2 + 0.1 * FT, z3 + 0.1 * FT]:
    polyline("Interior-Plan", [
        (hx + wall_t, hy + wall_t, z),
        (hall_x0, hy + wall_t, z),
        (hall_x0, hy + house_d - wall_t, z),
        (hx + wall_t, hy + house_d - wall_t, z),
        (hx + wall_t, hy + wall_t, z),
    ])


# Roof deck / parapet read
box("Townhouse-FrontFrame", hx, hy, 3 * level_h, hx + house_w, hy + house_d, total_h)
box("Townhouse-Glass", hx + 4.0 * FT, hy + house_d - 8.0 * FT, 3 * level_h, hx + house_w - 4.0 * FT, hy + house_d - 7.6 * FT, total_h - 0.8 * FT)


# Annotation labels
labels = [
    ("GARAGE", hx + 4.2 * FT, hy + 6.0 * FT, 1.0 * FT),
    ("ENTRY", hx + 14.0 * FT, hy + 3.5 * FT, 4.2 * FT),
    ("FLEX / OFFICE", hx + 5.5 * FT, hy + 29.0 * FT, 1.0 * FT),
    ("KITCHEN", hx + 4.5 * FT, hy + 5.0 * FT, z2 + 1.0 * FT),
    ("DINING", hx + 5.0 * FT, hy + 15.0 * FT, z2 + 1.0 * FT),
    ("LIVING", hx + 5.0 * FT, hy + 27.0 * FT, z2 + 1.0 * FT),
    ("BEDROOM 2", hx + 4.0 * FT, hy + 7.0 * FT, z3 + 1.0 * FT),
    ("PRIMARY", hx + 4.0 * FT, hy + 28.0 * FT, z3 + 1.0 * FT),
]
rs.CurrentLayer("Interior-Annotations")
for text, x, y, z in labels:
    rs.AddText(text, (x, y, z), 0.55 * FT)


rs.CurrentLayer("Default")
rs.Command("_ZoomExtents", False)
print("Modern townhouse v2 applied to active Rhino document.")
