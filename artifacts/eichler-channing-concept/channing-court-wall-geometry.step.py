from build123d import Box, Compound, Cylinder, Location


WALL = 0.55
INT_WALL = 0.38
WALL_H = 8.8
PLATE = 0.45


def box(name, width, depth, height, x, y, z=0):
    shape = Box(width, depth, height)
    shape.label = name
    return shape.located(Location((x, y, z + height / 2)))


def cyl(name, radius, height, x, y, z=0):
    shape = Cylinder(radius, height)
    shape.label = name
    return shape.located(Location((x, y, z + height / 2)))


def wall_x(name, x1, x2, y, height=WALL_H, thick=WALL, z=PLATE):
    return box(name, abs(x2 - x1), thick, height, (x1 + x2) / 2, y, z)


def wall_y(name, x, y1, y2, height=WALL_H, thick=WALL, z=PLATE):
    return box(name, thick, abs(y2 - y1), height, x, (y1 + y2) / 2, z)


def window_x(name, x1, x2, y, sill=2.2, head=7.1):
    parts = []
    parts.append(wall_x(f"{name} sill wall", x1, x2, y, sill, WALL, PLATE))
    parts.append(wall_x(f"{name} header wall", x1, x2, y, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_y(f"{name} left jamb", x1, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(wall_y(f"{name} right jamb", x2, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} glass pane", abs(x2 - x1), 0.08, head - sill, (x1 + x2) / 2, y, PLATE + sill))
    return parts


def window_y(name, x, y1, y2, sill=2.2, head=7.1):
    parts = []
    parts.append(wall_y(f"{name} sill wall", x, y1, y2, sill, WALL, PLATE))
    parts.append(wall_y(f"{name} header wall", x, y1, y2, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_x(f"{name} lower jamb", x - WALL / 2, x + WALL / 2, y1, WALL_H, WALL, PLATE))
    parts.append(wall_x(f"{name} upper jamb", x - WALL / 2, x + WALL / 2, y2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} glass pane", 0.08, abs(y2 - y1), head - sill, x, (y1 + y2) / 2, PLATE + sill))
    return parts


def slider_x(name, x1, x2, y, head=7.6):
    parts = []
    parts.append(wall_x(f"{name} transom/header", x1, x2, y, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_y(f"{name} left jamb", x1, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(wall_y(f"{name} right jamb", x2, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} sliding glass panels", abs(x2 - x1), 0.08, head, (x1 + x2) / 2, y, PLATE))
    return parts


def door_x(name, x1, x2, y, head=7.0):
    parts = []
    parts.append(wall_x(f"{name} door header", x1, x2, y, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_y(f"{name} left jamb", x1, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(wall_y(f"{name} right jamb", x2, y - WALL / 2, y + WALL / 2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} door leaf shown open", 0.16, 3.0, 6.8, x1 + 1.6, y + 1.3, PLATE))
    return parts


def door_y(name, x, y1, y2, head=7.0):
    parts = []
    parts.append(wall_y(f"{name} door header", x, y1, y2, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_x(f"{name} lower jamb", x - WALL / 2, x + WALL / 2, y1, WALL_H, WALL, PLATE))
    parts.append(wall_x(f"{name} upper jamb", x - WALL / 2, x + WALL / 2, y2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} door leaf shown open", 2.8, 0.16, 6.8, x + 1.2, y1 + 1.5, PLATE))
    return parts


def slider_y(name, x, y1, y2, head=7.6):
    parts = []
    parts.append(wall_y(f"{name} transom/header", x, y1, y2, WALL_H - head, WALL, PLATE + head))
    parts.append(wall_x(f"{name} lower jamb", x - WALL / 2, x + WALL / 2, y1, WALL_H, WALL, PLATE))
    parts.append(wall_x(f"{name} upper jamb", x - WALL / 2, x + WALL / 2, y2, WALL_H, WALL, PLATE))
    parts.append(box(f"{name} sliding glass panels", 0.08, abs(y2 - y1), head, x, (y1 + y2) / 2, PLATE))
    return parts


def site_parts():
    parts = [
        box("survey placeholder lot slab 75 x 95 ft", 75, 95, 0.16, 0, 0, -0.16),
        box("main house concrete slab", 56, 34, PLATE, 0, -16, 0),
        box("open atrium floor finish", 14, 12, 0.08, 0, -16, PLATE),
        box("garden pavilion slab", 28, 22, PLATE, 18, 28, 0),
        box("permeable driveway", 10, 38, 0.12, -31, -26, 0),
        box("rear commons deck", 20, 31, 0.16, 8, 8, PLATE),
    ]
    for name, x, y, radius, h in [
        ("front protected tree", -25, -39, 4.5, 13),
        ("rear shade tree", -29, 34, 5.2, 16),
        ("east privacy tree", 35, 9, 4.0, 12),
    ]:
        parts.append(cyl(f"{name} trunk", 0.35, h * 0.45, x, y, 0))
        parts.append(cyl(f"{name} canopy mass", radius, h * 0.35, x, y, h * 0.5))
    return parts


def house_wall_parts():
    parts = []

    # Exterior wall geometry with real openings left as gaps.
    parts.extend(door_x("recessed front entry", -4, 0, 1))
    parts.extend(slider_x("living room south glass wall", 8, 24, 1))
    parts.append(wall_x("front wall west bedroom segment", -28, -4, 1))
    parts.append(wall_x("front wall entry to living pier", 0, 8, 1))
    parts.append(wall_x("front wall east pier", 24, 28, 1))

    parts.extend(slider_x("rear bedroom garden slider", -22, -10, -33))
    parts.extend(window_x("rear bath high window", 2, 9, -33, sill=4.2, head=7.4))
    parts.extend(slider_x("rear studio bedroom slider", 13, 25, -33))
    parts.append(wall_x("rear wall west corner", -28, -22, -33))
    parts.append(wall_x("rear wall between sliders", -10, 2, -33))
    parts.append(wall_x("rear wall bath to studio", 9, 13, -33))
    parts.append(wall_x("rear wall east corner", 25, 28, -33))

    parts.extend(window_y("west bedroom clerestory one", -28, -29, -23, sill=5.2, head=7.6))
    parts.extend(window_y("west bedroom clerestory two", -28, -14, -8, sill=5.2, head=7.6))
    parts.append(wall_y("west side wall north segment", -28, -33, -29))
    parts.append(wall_y("west side wall middle segment", -28, -23, -14))
    parts.append(wall_y("west side wall south segment", -28, -8, 1))
    parts.extend(window_y("east kitchen garden window", 28, -18, -10, sill=3.2, head=7.2))
    parts.extend(slider_y("east living garden slider", 28, -7, -1))
    parts.append(wall_y("east side wall north segment", 28, -33, -18))
    parts.append(wall_y("east side wall middle segment", 28, -10, -7))

    # Atrium glass/wall ring. Each side is a true segment around a void.
    parts.extend(slider_x("atrium south slider to living", -6.5, 6.5, -10))
    parts.extend(slider_x("atrium north slider to bedrooms", -6.5, 6.5, -22))
    parts.append(wall_x("atrium south west wall segment", -7.5, -6.5, -10))
    parts.append(wall_x("atrium south east wall segment", 6.5, 7.5, -10))
    parts.append(wall_x("atrium north west wall segment", -7.5, -6.5, -22))
    parts.append(wall_x("atrium north east wall segment", 6.5, 7.5, -22))
    parts.append(wall_y("atrium west glass jamb wall", -7.5, -22, -10, 7.4, 0.28))
    parts.append(wall_y("atrium east glass jamb wall", 7.5, -22, -10, 7.4, 0.28))
    parts.append(box("atrium planting rectangle", 8, 5, 0.22, 0, -16, PLATE + 0.08))

    # Interior partitions, named as rooms and with openings.
    parts.append(wall_y("bedroom wing corridor wall north", -9.5, -33, -22, WALL_H, INT_WALL))
    parts.extend(door_y("bedroom one door", -9.5, -30, -27.2))
    parts.extend(door_y("bedroom two door", -9.5, -24.5, -21.7))
    parts.append(wall_x("bedroom one two partition", -28, -9.5, -27, WALL_H, INT_WALL))
    parts.append(wall_x("bedroom two bath partition", -28, -9.5, -22, WALL_H, INT_WALL))

    parts.append(wall_y("living kitchen storage wall", 9.5, -33, -22, WALL_H, INT_WALL))
    parts.extend(door_y("bath core pocket door", 9.5, -31, -28.2))
    parts.append(wall_x("bath core north wall", 9.5, 28, -27.5, WALL_H, INT_WALL))
    parts.append(wall_x("kitchen work wall", 9.5, 28, -12, 7.2, INT_WALL))
    parts.append(box("kitchen island", 7.5, 3.2, 3.0, 18, -16, PLATE))
    parts.append(box("built in storage run", 13, 2.2, 7.0, -19, -6, PLATE))

    # Posts, beams, and roof plates as separate actual geometry.
    for x in [-26, -14, -7.5, 7.5, 14, 26]:
        for y in [0.5, -16, -32.5]:
            parts.append(box(f"4x4 post x{x} y{y}", 0.35, 0.35, 9.4, x, y, PLATE))
    for y in [0.7, -10, -22, -32.8]:
        parts.append(box(f"exposed beam line y{y}", 56, 0.28, 0.45, 0, y, 9.35))
    for x in [-28, -7.5, 7.5, 28]:
        parts.append(box(f"exposed beam line x{x}", 0.28, 34, 0.45, x, -16, 9.35))

    parts.append(box("front roof plate with atrium cutout west", 20, 34, 0.42, -18, -16, 9.85))
    parts.append(box("front roof plate with atrium cutout east", 20, 34, 0.42, 18, -16, 9.85))
    parts.append(box("front roof plate south band", 16, 10, 0.42, 0, -3.5, 9.85))
    parts.append(box("front roof plate north band", 16, 10, 0.42, 0, -28.5, 9.85))
    parts.append(box("deep front fascia", 58, 0.75, 1.1, 0, 1.55, 9.25))

    return parts


def pavilion_wall_parts():
    parts = []
    parts.extend(slider_x("pavilion front sliding wall", 8, 28, 17))
    parts.append(wall_x("pavilion front west pier", 4, 8, 17))
    parts.append(wall_x("pavilion front east pier", 28, 32, 17))
    parts.extend(window_x("pavilion rear high window", 13, 23, 39, sill=4.0, head=7.5))
    parts.append(wall_x("pavilion rear west wall", 4, 13, 39))
    parts.append(wall_x("pavilion rear east wall", 23, 32, 39))
    parts.append(wall_y("pavilion west wall", 4, 17, 39))
    parts.append(wall_y("pavilion east wall", 32, 17, 39))

    parts.append(wall_y("pavilion bath wall", 12, 29, 39, WALL_H, INT_WALL))
    parts.extend(door_y("pavilion bath door", 12, 28.5, 31.3))
    parts.append(wall_x("pavilion kitchenette wall", 22, 32, 32.5, 7.2, INT_WALL))
    parts.append(box("pavilion kitchenette cabinets", 8, 2.2, 3.0, 27, 34, PLATE))
    parts.append(box("pavilion built in bed platform", 10, 6, 1.6, 10, 22, PLATE))
    parts.append(box("pavilion roof plate", 30, 24, 0.42, 18, 28, 10.0))
    parts.append(box("pavilion front fascia", 31, 0.75, 1.1, 18, 16.35, 9.3))
    return parts


def trellis_and_qr_parts():
    parts = []
    for x in [0, 8, 16]:
        for y in [-2, 9, 20]:
            parts.append(box(f"trellis post x{x} y{y}", 0.38, 0.38, 8.0, x, y, PLATE))
    for y in [-4, 0, 4, 8, 12, 16, 20]:
        parts.append(box(f"trellis roof slat y{y}", 20, 0.26, 0.28, 8, y, 8.55))

    parts.append(box("QR project sign post", 0.35, 0.35, 4.2, 23, -44, 0))
    parts.append(box("QR project sign board", 4.5, 0.3, 3.0, 23, -43.8, 3.2))
    for dx, dz in [(-1.2, 0.8), (0, 0.8), (1.1, 0.8), (-1.2, -0.1), (0.9, -0.2), (-0.2, -0.9)]:
        parts.append(box("raised QR tile", 0.42, 0.08, 0.42, 23 + dx, -43.55, 3.2 + dz))
    return parts


def gen_step():
    parts = []
    parts.extend(site_parts())
    parts.extend(house_wall_parts())
    parts.extend(pavilion_wall_parts())
    parts.extend(trellis_and_qr_parts())
    return Compound(children=parts, label="Channing Court actual wall geometry concept")
