#!/usr/bin/env python3
"""
Add a modern Newark townhouse-style interior iteration to the active Rhino document.

This script is designed to be executed through:
  python3 ~/hii/scripts/rhino_execute.py --file ~/hii/tools/newark-house/interior_townhouse_iteration.py
"""

import rhinoscriptsyntax as rs
import scriptcontext as sc
import System.Drawing


FT = 304.8


def ensure_layer(name, rgb):
    if not rs.IsLayer(name):
        rs.AddLayer(name, System.Drawing.Color.FromArgb(*rgb))


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


def wall(layer, x0, y0, z0, x1, y1, z1):
    return box(layer, x0, y0, z0, x1, y1, z1)


def line_rect(layer, x0, y0, x1, y1, z):
    rs.CurrentLayer(layer)
    pts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x0, y0, z)]
    return rs.AddPolyline(pts)


layers = {
    "Interior-Floorplates": (200, 200, 200),
    "Interior-Stairs": (170, 140, 90),
    "Interior-Walls": (235, 225, 215),
    "Interior-Glass": (150, 210, 235),
    "Interior-Fixtures": (120, 160, 200),
    "Interior-Furniture": (185, 150, 115),
    "Interior-Annotations": (80, 80, 80),
}
for name, rgb in layers.items():
    ensure_layer(name, rgb)


# Base envelope aligned to the existing narrow-house/townhouse massing.
lot_w = 40 * FT
front_set = 25 * FT
side_set = 5 * FT
buildable_w = 30 * FT
house_w = 28 * FT
house_d = 14 * FT
hx = side_set + (buildable_w - house_w) / 2
hy = front_set


# Interior strategy:
# - Lower level / street level: garage + foyer + stair + mechanical/storage
# - Main level: open kitchen / dining / living
# - Upper level: front bedroom, rear primary, bath + laundry spine
floor_h = 9 * FT
slab_t = 0.5 * FT
wall_t = 0.5 * FT
guard_t = 0.15 * FT
landing_d = 3.5 * FT
stair_w = 3.25 * FT
tread_d = 11.0 * 25.4
riser_h = 7.0 * 25.4


# Clear out older interior iteration layers so reruns stay clean.
for lname in layers:
    ids = rs.ObjectsByLayer(lname) or []
    if ids:
        rs.DeleteObjects(ids)


# Floor plates
for level in [0, floor_h, 2 * floor_h]:
    box("Interior-Floorplates", hx + wall_t, hy + wall_t, level - slab_t, hx + house_w - wall_t, hy + house_d - wall_t, level)


# Level 1: garage / entry / stair / mech
garage_d = 8.4 * FT
entry_d = 3.5 * FT
service_d = house_d - garage_d - entry_d
stair_x0 = hx + house_w - wall_t - stair_w - 0.5 * FT
stair_x1 = stair_x0 + stair_w

wall("Interior-Walls", hx + wall_t, hy + garage_d, 0, hx + house_w - wall_t, hy + garage_d + wall_t, floor_h)
wall("Interior-Walls", stair_x0 - wall_t, hy + garage_d, 0, stair_x0, hy + house_d - wall_t, floor_h)
wall("Interior-Walls", hx + 5.8 * FT, hy + garage_d, 0, hx + 5.8 * FT + wall_t, hy + house_d - wall_t, floor_h)

box("Interior-Furniture", hx + wall_t + 0.2 * FT, hy + wall_t + 0.2 * FT, 0, hx + house_w - wall_t - 0.2 * FT, hy + garage_d - 0.2 * FT, 8 * FT)
box("Interior-Fixtures", hx + 0.8 * FT, hy + garage_d + 0.8 * FT, 0, hx + 5.2 * FT, hy + house_d - 0.8 * FT, 7.5 * FT)
line_rect("Interior-Annotations", hx + wall_t, hy + wall_t, hx + house_w - wall_t, hy + garage_d, 0.05 * FT)


# U-shaped stair stack through three levels
def add_stair_run(base_z, run_y0, direction):
    for i in range(8):
        z0 = base_z + i * riser_h
        z1 = z0 + riser_h
        if direction == 1:
            y0 = run_y0 + i * tread_d
        else:
            y0 = run_y0 + (7 - i) * tread_d
        y1 = y0 + tread_d
        box("Interior-Stairs", stair_x0, y0, z0, stair_x1, y1, z1)


stair_run_len = 8 * tread_d
stair_y0 = hy + house_d - wall_t - stair_run_len - landing_d
add_stair_run(0, stair_y0, 1)
box("Interior-Stairs", stair_x0, stair_y0 + stair_run_len, 8 * riser_h, stair_x1, stair_y0 + stair_run_len + landing_d, 8 * riser_h + 0.3 * FT)
add_stair_run(8 * riser_h + 0.3 * FT, stair_y0, -1)

add_stair_run(floor_h, stair_y0, 1)
box("Interior-Stairs", stair_x0, stair_y0 + stair_run_len, floor_h + 8 * riser_h, stair_x1, stair_y0 + stair_run_len + landing_d, floor_h + 8 * riser_h + 0.3 * FT)
add_stair_run(floor_h + 8 * riser_h + 0.3 * FT, stair_y0, -1)

wall("Interior-Glass", stair_x0 - guard_t, stair_y0, floor_h, stair_x0, stair_y0 + stair_run_len + landing_d, floor_h + 3.25 * FT)
wall("Interior-Glass", stair_x0 - guard_t, stair_y0, 2 * floor_h, stair_x0, stair_y0 + stair_run_len + landing_d, 2 * floor_h + 3.25 * FT)


# Level 2: open-plan kitchen / dining / living
level2_z0 = floor_h
level2_z1 = 2 * floor_h
kitchen_d = 4.5 * FT
powder_w = 5.0 * FT
powder_d = 6.0 * FT

wall("Interior-Walls", stair_x0 - wall_t, hy + wall_t, level2_z0, stair_x0, hy + house_d - wall_t, level2_z1)
wall("Interior-Walls", stair_x0 - powder_w, hy + kitchen_d, level2_z0, stair_x0, hy + kitchen_d + wall_t, level2_z1)
wall("Interior-Walls", stair_x0 - powder_w, hy + kitchen_d, level2_z0, stair_x0 - powder_w + wall_t, hy + kitchen_d + powder_d, level2_z1)

box("Interior-Furniture", hx + wall_t + 0.5 * FT, hy + wall_t + 0.4 * FT, level2_z0, hx + house_w - wall_t - stair_w - 1.5 * FT, hy + kitchen_d, level2_z0 + 3 * FT)
box("Interior-Furniture", hx + 9.0 * FT, hy + kitchen_d + 1.2 * FT, level2_z0, hx + 15.0 * FT, hy + kitchen_d + 4.0 * FT, level2_z0 + 3.0 * FT)
box("Interior-Furniture", hx + 4.0 * FT, hy + house_d - 5.3 * FT, level2_z0, hx + 12.5 * FT, hy + house_d - 2.2 * FT, level2_z0 + 1.6 * FT)
box("Interior-Furniture", hx + 14.0 * FT, hy + house_d - 6.0 * FT, level2_z0, hx + 23.5 * FT, hy + house_d - 1.5 * FT, level2_z0 + 1.8 * FT)
box("Interior-Fixtures", stair_x0 - powder_w + 0.8 * FT, hy + kitchen_d + 0.8 * FT, level2_z0, stair_x0 - 1.2 * FT, hy + kitchen_d + powder_d - 0.8 * FT, level2_z0 + 2.8 * FT)


# Level 3: bedrooms / bath / laundry
level3_z0 = 2 * floor_h
level3_z1 = 3 * floor_h
hall_w = 3.5 * FT
bath_d = 7.0 * FT
laundry_d = 3.0 * FT
mid_y = hy + house_d * 0.5

wall("Interior-Walls", hx + wall_t, mid_y, level3_z0, hx + house_w - wall_t, mid_y + wall_t, level3_z1)
wall("Interior-Walls", stair_x0 - hall_w, hy + wall_t, level3_z0, stair_x0 - hall_w + wall_t, hy + house_d - wall_t, level3_z1)
wall("Interior-Walls", stair_x0 - hall_w - bath_d, hy + 6.0 * FT, level3_z0, stair_x0 - hall_w, hy + 6.0 * FT + wall_t, level3_z1)

box("Interior-Furniture", hx + 2.0 * FT, hy + 1.5 * FT, level3_z0, hx + 10.5 * FT, hy + 7.0 * FT, level3_z0 + 2.1 * FT)
box("Interior-Furniture", hx + 2.5 * FT, mid_y + 1.0 * FT, level3_z0, hx + 12.0 * FT, hy + house_d - 2.0 * FT, level3_z0 + 2.1 * FT)
box("Interior-Furniture", hx + house_w - 7.0 * FT, hy + 1.2 * FT, level3_z0, hx + house_w - 1.2 * FT, hy + 3.0 * FT, level3_z0 + 7.0 * FT)
box("Interior-Furniture", hx + house_w - 7.0 * FT, mid_y + 1.2 * FT, level3_z0, hx + house_w - 1.2 * FT, mid_y + 3.0 * FT, level3_z0 + 7.0 * FT)
box("Interior-Fixtures", stair_x0 - hall_w - bath_d + 0.6 * FT, hy + 6.2 * FT, level3_z0, stair_x0 - hall_w - 1.0 * FT, hy + 12.0 * FT, level3_z0 + 2.8 * FT)
box("Interior-Fixtures", stair_x0 - hall_w - 3.0 * FT, hy + 1.0 * FT, level3_z0, stair_x0 - hall_w - 0.5 * FT, hy + 1.0 * FT + laundry_d, level3_z0 + 2.8 * FT)


# Simple labels for quick viewport reading
labels = [
    ("GARAGE / FLEX", hx + 8 * FT, hy + 4 * FT, 1 * FT),
    ("ENTRY + STORAGE", hx + 2.5 * FT, hy + 11.5 * FT, 1 * FT),
    ("OPEN KITCHEN / DINING", hx + 8 * FT, hy + 3.5 * FT, floor_h + 1 * FT),
    ("LIVING", hx + 11 * FT, hy + 11 * FT, floor_h + 1 * FT),
    ("BEDROOM", hx + 5 * FT, hy + 3.5 * FT, 2 * floor_h + 1 * FT),
    ("PRIMARY", hx + 5 * FT, hy + 11 * FT, 2 * floor_h + 1 * FT),
]
rs.CurrentLayer("Interior-Annotations")
for text, x, y, z in labels:
    rs.AddText(text, (x, y, z), 0.6 * FT)

rs.CurrentLayer("Default")
rs.Command("_ZoomExtents", False)
print("Modern townhouse interior iteration added to current Rhino document.")
