from build123d import Box, Compound, Cylinder, Location, Rotation


def part_box(name, width, depth, height, x, y, z=0):
    shape = Box(width, depth, height)
    shape.label = name
    return shape.located(Location((x, y, z + height / 2)))


def part_cylinder(name, radius, height, x, y, z=0):
    shape = Cylinder(radius, height)
    shape.label = name
    return shape.located(Location((x, y, z + height / 2)))


def rotated_box(name, width, depth, height, x, y, z, angle_degrees):
    shape = Box(width, depth, height)
    shape.label = name
    return shape.located(
        Location((x, y, z + height / 2), (0, 0, angle_degrees))
    )


def eichler_house():
    parts = []

    # Slabs and atrium-centered plan. Feet are represented as CAD model units.
    parts.append(part_box("main house slab - low existing Eichler footprint", 56, 34, 0.45, 0, -16, 0))
    parts.append(part_box("left bedroom wing floor", 18, 32, 0.35, -19, -16, 0.45))
    parts.append(part_box("right living kitchen wing floor", 18, 32, 0.35, 19, -16, 0.45))
    parts.append(part_box("rear bedroom band floor", 56, 10, 0.35, 0, -31, 0.45))
    parts.append(part_box("front entry band floor", 56, 8, 0.35, 0, -3, 0.45))

    # Exterior walls, intentionally low and thin.
    wall_h = 8.8
    parts.append(part_box("front low wall and entry datum", 56, 0.55, wall_h, 0, 1, 0.8))
    parts.append(part_box("rear bedroom wall", 56, 0.55, wall_h, 0, -33, 0.8))
    parts.append(part_box("west side wall", 0.55, 34, wall_h, -28, -16, 0.8))
    parts.append(part_box("east side wall", 0.55, 34, wall_h, 28, -16, 0.8))

    # Atrium edges. The middle is intentionally open to sky.
    parts.append(part_box("atrium north glass line", 15, 0.28, 7.2, 0, -22, 0.8))
    parts.append(part_box("atrium south glass line", 15, 0.28, 7.2, 0, -10, 0.8))
    parts.append(part_box("atrium west glass line", 0.28, 12, 7.2, -7.5, -16, 0.8))
    parts.append(part_box("atrium east glass line", 0.28, 12, 7.2, 7.5, -16, 0.8))
    parts.append(part_box("open atrium landscape court", 13, 10, 0.18, 0, -16, 0.9))

    # Post-and-beam rhythm.
    for x in [-26, -14, -7.5, 7.5, 14, 26]:
        for y in [0.5, -16, -32.5]:
            parts.append(part_box(f"exposed post x{x} y{y}", 0.6, 0.6, 9.4, x, y, 0.8))

    # Thin flat roof planes around the atrium.
    roof_z = 9.9
    parts.append(part_box("front flat roof plane", 56, 8.5, 0.55, 0, -3.0, roof_z))
    parts.append(part_box("rear flat roof plane", 56, 10.5, 0.55, 0, -30.8, roof_z))
    parts.append(part_box("west flat roof plane", 20.8, 16.5, 0.55, -17.6, -16, roof_z))
    parts.append(part_box("east flat roof plane", 20.8, 16.5, 0.55, 17.6, -16, roof_z))
    parts.append(part_box("deep fascia street edge", 58, 0.9, 1.2, 0, 1.7, roof_z - 0.6))

    return parts


def garden_pavilion():
    parts = []
    parts.append(part_box("garden room slab - ADU ready", 28, 22, 0.45, 18, 28, 0))
    parts.append(part_box("garden room west wall", 0.55, 22, 9.2, 4, 28, 0.45))
    parts.append(part_box("garden room east wall", 0.55, 22, 9.2, 32, 28, 0.45))
    parts.append(part_box("garden room rear wall", 28, 0.55, 9.2, 18, 39, 0.45))
    parts.append(part_box("garden room front glass slider", 20, 0.3, 8.2, 18, 17, 0.45))
    parts.append(part_box("garden room flat roof", 30, 24, 0.55, 18, 28, 10.0))
    parts.append(part_box("garden room deep fascia", 31, 0.85, 1.2, 18, 16.3, 9.4))
    parts.append(part_box("ADU kitchenette service block", 8, 3, 7.2, 29, 33, 0.45))
    parts.append(part_box("bathroom core", 7, 6, 7.2, 7.5, 34, 0.45))
    return parts


def site_and_landscape():
    parts = []
    parts.append(part_box("7125 sf lot reference slab", 75, 95, 0.18, 0, 0, -0.18))
    parts.append(part_box("street setback garden", 62, 13, 0.12, 0, -43, 0))
    parts.append(part_box("permeable driveway strip", 10, 38, 0.14, -31, -26, 0))
    parts.append(part_box("rear edible shade garden", 22, 21, 0.16, -20, 28, 0))
    parts.append(part_box("covered exterior commons deck", 18, 31, 0.25, 8, 8, 0.2))

    # Trellis between house and garden room.
    for x in [0, 8, 16]:
        parts.append(part_box(f"trellis post {x}", 0.45, 0.45, 8.2, x, 8, 0.45))
    for y in [-4, 4, 12, 20]:
        parts.append(part_box(f"trellis slat y{y}", 19, 0.32, 0.32, 8, y, 8.7))

    # Simplified trees and planting masses.
    for name, x, y, radius, h in [
        ("protected front canopy", -25, -39, 4.5, 13),
        ("rear shade tree", -29, 34, 5.2, 16),
        ("east privacy tree", 35, 9, 4.0, 12),
    ]:
        parts.append(part_cylinder(f"{name} trunk", 0.35, h * 0.45, x, y, 0.2))
        parts.append(part_cylinder(f"{name} canopy", radius, h * 0.35, x, y, h * 0.5))

    # QR project sign at public edge.
    parts.append(part_box("QR project sign post", 0.35, 0.35, 4.2, 23, -44, 0))
    parts.append(part_box("QR concept sign board", 4.5, 0.3, 3.0, 23, -43.8, 3.2))
    for dx, dz in [(-1.2, 0.8), (0, 0.8), (1.1, 0.8), (-1.2, -0.1), (0.9, -0.2), (-0.2, -0.9)]:
        parts.append(part_box("raised QR tile", 0.42, 0.08, 0.42, 23 + dx, -43.55, 3.2 + dz))

    return parts


def gen_step():
    parts = []
    parts.extend(site_and_landscape())
    parts.extend(eichler_house())
    parts.extend(garden_pavilion())
    return Compound(children=parts, label="Channing Court detailed Eichler CAD concept")
