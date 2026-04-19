"""
Rhino 8 Python Script: Refine AI-generated mesh inside Rhino.
Run this INSIDE Rhino's ScriptEditor (Tools > PythonScript > Edit).

Operations:
1. Import mesh from 3DM/OBJ
2. Clean up topology (remove degenerate faces, fix normals)
3. Organize into layers
4. Set up materials and rendering
5. Create architectural interpretations (scale, section cuts, base plinth)
"""

import Rhino
import Rhino.Geometry as rg
import Rhino.RhinoDoc as rd
import scriptcontext as sc
import rhinoscriptsyntax as rs
import System.Drawing as sd


def setup_layers():
    """Create organized layer structure for the project."""
    layers = {
        "AI_Generated": sd.Color.FromArgb(200, 200, 200),
        "AI_Generated::Original": sd.Color.FromArgb(180, 180, 180),
        "AI_Generated::Refined": sd.Color.FromArgb(220, 220, 220),
        "Design": sd.Color.FromArgb(255, 255, 255),
        "Design::Massing": sd.Color.FromArgb(200, 210, 220),
        "Design::Base_Plinth": sd.Color.FromArgb(160, 150, 140),
        "Design::Openings": sd.Color.FromArgb(100, 150, 200),
        "Context": sd.Color.FromArgb(230, 225, 220),
        "Context::Ground_Plane": sd.Color.FromArgb(200, 195, 185),
    }

    for name, color in layers.items():
        if not rs.IsLayer(name):
            rs.AddLayer(name, color)
    print("Layers created.")


def import_and_place(file_path, target_height_m=5.0):
    """Import a 3DM or OBJ file and scale to architectural dimensions."""
    # Import
    rs.Command(f'-Import "{file_path}" Enter', False)

    # Get the imported objects
    objs = rs.LastCreatedObjects()
    if not objs:
        print("No objects imported.")
        return

    # Get bounding box
    bbox = rs.BoundingBox(objs)
    if bbox:
        current_height = bbox[4][2] - bbox[0][2]  # Z extent
        if current_height > 0:
            scale_factor = target_height_m / current_height
            # Scale uniformly
            center = [(bbox[0][0] + bbox[6][0]) / 2,
                      (bbox[0][1] + bbox[6][1]) / 2,
                      bbox[0][2]]
            rs.ScaleObjects(objs, center, [scale_factor] * 3)
            print(f"Scaled by {scale_factor:.3f}x to {target_height_m}m height")

    # Move to layer
    for obj in objs:
        rs.ObjectLayer(obj, "AI_Generated::Original")

    # Center on origin at ground plane
    bbox = rs.BoundingBox(objs)
    if bbox:
        cx = (bbox[0][0] + bbox[6][0]) / 2
        cy = (bbox[0][1] + bbox[6][1]) / 2
        cz = bbox[0][2]
        rs.MoveObjects(objs, [-cx, -cy, -cz])

    print(f"Imported {len(objs)} objects, centered at origin on ground plane.")
    return objs


def clean_mesh(mesh_id):
    """Clean up mesh topology."""
    mesh = rs.coercemesh(mesh_id)
    if not mesh:
        print("Not a mesh object.")
        return

    # Remove degenerate faces
    mesh.Faces.CullDegenerateFaces()
    # Unify normals
    mesh.UnifyNormals()
    # Recompute normals
    mesh.Normals.ComputeNormals()
    # Compact
    mesh.Compact()

    # Replace original
    sc.doc.Objects.Replace(rs.coerceguid(mesh_id), mesh)
    print(f"Cleaned: {mesh.Vertices.Count} verts, {mesh.Faces.Count} faces")


def add_ground_plane(size=20.0):
    """Add a ground plane for context."""
    corners = [
        rg.Point3d(-size, -size, 0),
        rg.Point3d(size, -size, 0),
        rg.Point3d(size, size, 0),
        rg.Point3d(-size, size, 0),
    ]
    srf = rg.NurbsSurface.CreateFromCorners(corners[0], corners[1], corners[2], corners[3])
    attr = Rhino.DocObjects.ObjectAttributes()
    attr.LayerIndex = sc.doc.Layers.FindByFullPath("Context::Ground_Plane", -1)
    if attr.LayerIndex < 0:
        attr.LayerIndex = 0
    sc.doc.Objects.AddSurface(srf, attr)
    print("Ground plane added.")


def add_base_plinth(objs, plinth_height=0.5):
    """Add a base plinth under the design object."""
    bbox = rs.BoundingBox(objs)
    if not bbox:
        return

    # Expand footprint slightly
    margin = 0.5
    x0, y0 = bbox[0][0] - margin, bbox[0][1] - margin
    x1, y1 = bbox[6][0] + margin, bbox[6][1] + margin

    pts = [
        rg.Point3d(x0, y0, -plinth_height),
        rg.Point3d(x1, y0, -plinth_height),
        rg.Point3d(x1, y1, -plinth_height),
        rg.Point3d(x0, y1, -plinth_height),
        rg.Point3d(x0, y0, -plinth_height),
    ]
    polyline = rg.Polyline(pts)
    curve = polyline.ToPolylineCurve()

    path = rg.LineCurve(rg.Point3d(0, 0, -plinth_height), rg.Point3d(0, 0, 0))
    extrusion = rg.Extrusion.Create(curve, plinth_height, True)

    if extrusion:
        attr = Rhino.DocObjects.ObjectAttributes()
        idx = sc.doc.Layers.FindByFullPath("Design::Base_Plinth", -1)
        if idx >= 0:
            attr.LayerIndex = idx
        sc.doc.Objects.AddExtrusion(extrusion, attr)
        print(f"Plinth added: {x1-x0:.1f} x {y1-y0:.1f} x {plinth_height:.1f}m")


def create_section_cut(objs, plane_origin=(0, 0, 2.5), plane_normal=(0, 0, 1)):
    """Create a horizontal section cut through the object."""
    plane = rg.Plane(
        rg.Point3d(*plane_origin),
        rg.Vector3d(*plane_normal)
    )

    for obj_id in objs:
        mesh = rs.coercemesh(obj_id)
        if mesh:
            polylines = rg.Intersect.Intersection.MeshPlane(mesh, plane)
            if polylines:
                attr = Rhino.DocObjects.ObjectAttributes()
                idx = sc.doc.Layers.FindByFullPath("Design::Openings", -1)
                if idx >= 0:
                    attr.LayerIndex = idx
                for pl in polylines:
                    sc.doc.Objects.AddPolyline(pl, attr)
                print(f"Section cut at Z={plane_origin[2]}m: {len(polylines)} curves")


def set_render_material(objs, material_name="Concrete", color=(200, 195, 185)):
    """Apply a basic render material to objects."""
    mat_idx = sc.doc.Materials.Add()
    mat = sc.doc.Materials[mat_idx]
    mat.Name = material_name
    mat.DiffuseColor = sd.Color.FromArgb(*color)
    mat.CommitChanges()

    for obj_id in objs:
        robj = sc.doc.Objects.FindId(rs.coerceguid(obj_id))
        if robj:
            attr = robj.Attributes.Duplicate()
            attr.MaterialIndex = mat_idx
            attr.MaterialSource = Rhino.DocObjects.ObjectMaterialSource.MaterialFromObject
            sc.doc.Objects.ModifyAttributes(robj, attr, True)
    print(f"Applied '{material_name}' material.")


# === MAIN WORKFLOW ===
# Uncomment and run the functions you need:

# setup_layers()
# objs = import_and_place("path/to/your/model.3dm", target_height_m=5.0)
# for obj in objs: clean_mesh(obj)
# add_ground_plane(20.0)
# add_base_plinth(objs, plinth_height=0.5)
# create_section_cut(objs, plane_origin=(0, 0, 2.5))
# set_render_material(objs, "Concrete", (200, 195, 185))
# sc.doc.Views.Redraw()
