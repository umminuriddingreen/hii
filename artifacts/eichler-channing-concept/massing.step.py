from build123d import Box, Compound, Location


def located_box(name, width, depth, height, x, y, z=0):
    box = Box(width, depth, height)
    box.label = name
    return box.located(Location((x, y, z + height / 2)))


def gen_step():
    # Feet are represented as model units. This is concept massing only.
    site = located_box("7125 sf lot envelope", 75, 95, 0.2, 0, 0, 0)
    house = located_box("existing single-story house", 54, 32, 11, 0, -14, 0.2)
    service_spine = located_box("all-electric service spine", 54, 6, 10, 0, 6, 0.2)
    garden_room = located_box("rear garden room ADU-ready pavilion", 26, 20, 12, 17, 28, 0.2)
    shade_trellis = located_box("covered exterior commons", 18, 30, 9, 9, 9, 0.2)
    return Compound(
        children=[site, house, service_spine, garden_room, shade_trellis],
        label="Channing Court Eichler retrofit massing",
    )
