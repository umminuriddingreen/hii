#!/usr/bin/env python3
"""
Convert 3D model files (OBJ, GLB, STL, PLY) to Rhino 3DM format.
Handles Y-up to Z-up conversion, scaling, and layer organization.

Usage:
    python convert_to_3dm.py <input_mesh> [--output <path>] [--scale <factor>]
"""

import argparse
import sys
from pathlib import Path

try:
    import rhino3dm
    import trimesh
    import numpy as np
except ImportError:
    print("Install: pip install rhino3dm trimesh numpy")
    sys.exit(1)


def convert_mesh_to_3dm(
    input_path: str,
    output_path: str = None,
    scale: float = 1.0,
    center: bool = False,
    fix_up_axis: bool = True,
    layer_name: str = "AI_Generated",
):
    """Convert a mesh file to Rhino 3DM format."""
    input_path = Path(input_path)
    if output_path is None:
        output_path = str(input_path.with_suffix(".3dm"))

    print(f"  Loading: {input_path.name} ({input_path.suffix})")

    # Load with trimesh
    scene = trimesh.load(str(input_path), force="scene")
    if isinstance(scene, trimesh.Scene):
        meshes = [(name, geo) for name, geo in scene.geometry.items()
                  if isinstance(geo, trimesh.Trimesh)]
    elif isinstance(scene, trimesh.Trimesh):
        meshes = [("mesh_0", scene)]
    else:
        print(f"  ERROR: Could not parse geometry from {input_path.name}")
        return None

    print(f"  Found {len(meshes)} mesh(es)")

    # Create 3DM file
    model = rhino3dm.File3dm()
    model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters

    # Create layers
    ai_layer = rhino3dm.Layer()
    ai_layer.Name = layer_name
    ai_layer.Color = (200, 200, 200, 255)
    ai_layer_idx = model.Layers.Add(ai_layer)

    original_layer = rhino3dm.Layer()
    original_layer.Name = f"{layer_name}/Original"
    original_layer.Color = (180, 180, 180, 255)
    orig_layer_idx = model.Layers.Add(original_layer)

    total_verts = 0
    total_faces = 0

    for mesh_name, tm_mesh in meshes:
        # Apply transforms
        if fix_up_axis:
            # Y-up to Z-up rotation (-90 deg around X)
            transform = np.array([
                [1, 0, 0, 0],
                [0, 0, -1, 0],
                [0, 1, 0, 0],
                [0, 0, 0, 1]
            ])
            tm_mesh.apply_transform(transform)

        if scale != 1.0:
            tm_mesh.apply_scale(scale)

        if center:
            tm_mesh.vertices -= tm_mesh.centroid

        # Convert to rhino3dm Mesh
        rh_mesh = rhino3dm.Mesh()
        for v in tm_mesh.vertices:
            rh_mesh.Vertices.Add(float(v[0]), float(v[1]), float(v[2]))
        for f in tm_mesh.faces:
            rh_mesh.Faces.AddFace(int(f[0]), int(f[1]), int(f[2]))
        rh_mesh.Normals.ComputeNormals()
        rh_mesh.Compact()

        # Add with attributes
        attr = rhino3dm.ObjectAttributes()
        attr.LayerIndex = orig_layer_idx
        attr.Name = mesh_name
        model.Objects.AddMesh(rh_mesh, attr)

        total_verts += len(tm_mesh.vertices)
        total_faces += len(tm_mesh.faces)

        # Report mesh info
        bbox = tm_mesh.bounding_box
        extents = bbox.extents
        print(f"    {mesh_name}: {len(tm_mesh.vertices)} verts, {len(tm_mesh.faces)} faces")
        print(f"      Extents: {extents[0]:.3f} x {extents[1]:.3f} x {extents[2]:.3f} m")
        print(f"      Watertight: {tm_mesh.is_watertight}")

    model.Write(str(output_path), 8)

    print(f"\n  Output: {output_path}")
    print(f"  Total: {total_verts} vertices, {total_faces} faces")
    print(f"  Layers: '{layer_name}', '{layer_name}/Original'")

    return output_path


def inspect_mesh(input_path: str):
    """Inspect a mesh file and print statistics."""
    p = Path(input_path)
    print(f"\n=== Mesh Inspection: {p.name} ===")
    print(f"  Format: {p.suffix}")
    print(f"  Size: {p.stat().st_size / 1024:.1f} KB")

    scene = trimesh.load(str(p))
    if isinstance(scene, trimesh.Scene):
        meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
    else:
        meshes = [scene]

    for i, m in enumerate(meshes):
        print(f"\n  Mesh {i}:")
        print(f"    Vertices: {len(m.vertices)}")
        print(f"    Faces: {len(m.faces)}")
        print(f"    Bounds: {m.bounds.tolist()}")
        print(f"    Extents: {m.extents.tolist()}")
        print(f"    Watertight: {m.is_watertight}")
        if m.is_watertight:
            print(f"    Volume: {m.volume:.4f}")
        print(f"    Center: {m.centroid.tolist()}")

    print(f"\n  Total: {sum(len(m.vertices) for m in meshes)} verts, "
          f"{sum(len(m.faces) for m in meshes)} faces")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert mesh to Rhino 3DM")
    parser.add_argument("input", help="Input mesh file (OBJ, GLB, STL, PLY)")
    parser.add_argument("--output", "-o", help="Output 3DM file path")
    parser.add_argument("--scale", type=float, default=1.0, help="Scale factor")
    parser.add_argument("--center", action="store_true", help="Center at origin")
    parser.add_argument("--no-fix-up", action="store_true", help="Skip Y-up to Z-up conversion")
    parser.add_argument("--inspect", action="store_true", help="Only inspect, don't convert")
    parser.add_argument("--layer", default="AI_Generated", help="Layer name in 3DM")
    args = parser.parse_args()

    if args.inspect:
        inspect_mesh(args.input)
    else:
        print(f"\n=== Converting to Rhino 3DM ===")
        convert_mesh_to_3dm(
            args.input, args.output, args.scale, args.center,
            not args.no_fix_up, args.layer
        )
