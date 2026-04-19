# Building Claude Code Skills for Rhino3D Integration

## Comprehensive Research Report

---

## Part 1: Claude Code Skills -- How They Work

### What is a Skill?

A Claude Code skill is a markdown file (`SKILL.md`) with optional YAML frontmatter that extends Claude's capabilities. When a skill is registered, Claude can either invoke it automatically (when relevant to conversation) or the user can invoke it directly via `/skill-name`.

Skills follow the [Agent Skills](https://agentskills.io) open standard.

### File Structure

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── template.md        # Template for Claude to fill in
├── examples/
│   └── sample.md      # Example output
└── scripts/
    └── helper.py      # Script Claude can execute
```

### Skill Locations

| Scope      | Path                                           |
|------------|------------------------------------------------|
| Personal   | `~/.claude/skills/<skill-name>/SKILL.md`       |
| Project    | `.claude/skills/<skill-name>/SKILL.md`         |
| Enterprise | Managed settings                               |
| Plugin     | `<plugin>/skills/<skill-name>/SKILL.md`        |

### SKILL.md Format

```yaml
---
name: my-skill                    # Slash command name
description: What this skill does # How Claude decides when to use it
disable-model-invocation: false   # true = only user can invoke
user-invocable: true              # false = only Claude can invoke
allowed-tools: Read, Grep, Bash   # Tools allowed without permission prompts
context: fork                     # Run in isolated subagent
agent: Explore                    # Subagent type (Explore, Plan, general-purpose, or custom)
model: <model-id>                 # Override model
effort: high                      # low, medium, high, max
paths: "*.py, src/**"             # Only activate for matching file patterns
shell: bash                       # bash or powershell
---

Markdown instructions here...
```

### Key Features

1. **String substitutions**: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$0`/`$1`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`
2. **Dynamic context injection**: `` !`command` `` runs shell commands and injects output before Claude sees the skill content
3. **Supporting files**: Reference docs, templates, scripts bundled alongside SKILL.md
4. **Subagent execution**: `context: fork` runs the skill in an isolated agent with its own context
5. **Tool restrictions**: `allowed-tools` grants specific tool access without per-use approval

### Tools Available to Skills

Skills have access to the same tools as Claude Code: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, plus any MCP tools configured. The `allowed-tools` field auto-approves specific tools. You can also use `Bash(python *)` to allow specific bash patterns.

---

## Part 2: Rhino3D Developer Ecosystem

### Available APIs and SDKs

| Technology | Language | Use Case |
|------------|----------|----------|
| **RhinoCommon** | C#, VB.NET, Python (IronPython) | Plugins, Grasshopper components, full geometry API |
| **Rhino.Python** | Python (IronPython in Rhino, CPython in Rhino 8+) | Scripting inside Rhino, automation |
| **rhino3dm** | Python (CPython), JavaScript | Read/write 3dm files WITHOUT Rhino installed |
| **openNURBS** | C/C++ | Low-level 3dm file I/O |
| **Rhino.Compute** | REST API (any language) | Headless/server-side geometry computation |
| **Grasshopper** | C#, Python, visual nodes | Parametric/algorithmic design |
| **Hops** | REST endpoints | Extend Grasshopper with remote compute |

### rhino3dm (Python) -- Critical for Claude Code Integration

`pip install rhino3dm` -- works standalone, no Rhino installation required.

```python
from rhino3dm import *

# Read a 3dm file
model = File3dm.Read("model.3dm")
for obj in model.Objects:
    geometry = obj.Geometry
    bbox = geometry.GetBoundingBox()
    print(f"{bbox.Min}, {bbox.Max}")

# Create geometry and write to 3dm
model = File3dm()
circle = Circle(Point3d(0, 0, 0), 5.0)
model.Objects.AddCurve(circle.ToNurbsCurve())
model.Write("output.3dm", 8)  # version 8
```

Key classes: `File3dm`, `Point3d`, `Vector3d`, `Line`, `Circle`, `Arc`, `Polyline`, `NurbsCurve`, `NurbsSurface`, `Brep`, `Mesh`, `Extrusion`, `BoundingBox`.

### Rhino.Compute REST API

Exposes RhinoCommon and Grasshopper as stateless HTTP endpoints.

- Base URL: `http://localhost:6500` (local) or cloud-deployed
- Endpoints: `/version`, `/healthcheck`, `/sdk`
- Geometry endpoints follow RhinoCommon namespace structure
- Can solve Grasshopper definitions remotely via Hops

### Supported 3D File Formats

Rhino natively supports: **3DM**, OBJ, STL, STEP, IGES, glTF/GLB, FBX, DWG, DXF, PLY, AMF, 3MF, DAE, and many more. The `rhino3dm` library works with 3DM natively; for format conversion you need Rhino.Compute or a running Rhino instance.

### Grasshopper Automation

Grasshopper definitions (.gh/.ghx) can be:
- Solved locally within Rhino
- Solved remotely via Rhino.Compute + Hops
- Scripted with Python/C# script components
- Automated via command line: `rhinocommon.RunScript("-Grasshopper ...")`

---

## Part 3: Proposed Claude Code Skills

### Skill 1: `rhino-import-comfyui` -- Import 3D Models from ComfyUI

**Purpose**: Import 3D models generated by ComfyUI (Wan 2.0/2.1 workflows) into Rhino, handling format conversion and placement.

**Rhino APIs Used**:
- `rhino3dm` (Python) for creating/writing 3DM files
- `trimesh` (Python) for reading OBJ/GLB/STL from ComfyUI output
- Optionally Rhino.Compute for advanced conversion

**Implementation**:

```
~/.claude/skills/rhino-import-comfyui/
├── SKILL.md
├── scripts/
│   ├── convert_to_3dm.py    # Core conversion logic
│   ├── inspect_model.py     # Analyze incoming mesh
│   └── requirements.txt     # rhino3dm, trimesh, numpy
└── examples/
    └── workflow.md
```

**SKILL.md**:

```yaml
---
name: rhino-import-comfyui
description: >
  Import 3D models generated by ComfyUI (OBJ, GLB, STL, PLY) into Rhino 3DM format.
  Use when the user wants to bring AI-generated 3D models into Rhino, convert mesh
  formats to 3DM, or process ComfyUI output for architectural/design work.
allowed-tools: Bash(python *), Read, Write, Glob, Grep
disable-model-invocation: true
---

# Import ComfyUI 3D Models into Rhino

You help users import 3D models generated by ComfyUI into Rhino3D.

## Workflow

1. **Locate the model**: Ask the user for the path to the ComfyUI output directory
   or specific file. ComfyUI typically outputs to `ComfyUI/output/` with formats
   like OBJ, GLB, STL, or PLY.

2. **Inspect the model**: Run the inspection script to understand the geometry:
   ```bash
   python ${CLAUDE_SKILL_DIR}/scripts/inspect_model.py "$0"
   ```

3. **Convert to 3DM**: Run the conversion script:
   ```bash
   python ${CLAUDE_SKILL_DIR}/scripts/convert_to_3dm.py "$0" --output "$1"
   ```
   If no output path given, default to the same directory with .3dm extension.

4. **Report results**: Tell the user:
   - Input format and mesh statistics (vertices, faces)
   - Bounding box dimensions
   - Output 3DM file path
   - Any issues (non-manifold edges, degenerate faces, scale concerns)

5. **Optional post-processing**: Offer to:
   - Scale the model (ComfyUI models may need rescaling for architectural use)
   - Center the model at origin
   - Orient the model (ComfyUI may use Y-up vs Rhino's Z-up)
   - Add to an existing 3DM file

## Common ComfyUI 3D Output Formats
- **OBJ** (.obj + .mtl): Most common from Wan 2.1 3D generation
- **GLB/glTF** (.glb, .gltf): Binary or JSON-based, common from TripoSR/InstantMesh
- **STL** (.stl): Simple mesh, no color/texture
- **PLY** (.ply): Point clouds or meshes with vertex colors

## Coordinate System Note
ComfyUI/most 3D AI models use Y-up coordinate system.
Rhino uses Z-up. The conversion script handles this automatically
by swapping Y and Z axes.
```

**scripts/convert_to_3dm.py** (key logic):

```python
#!/usr/bin/env python3
"""Convert OBJ/GLB/STL/PLY to Rhino 3DM format."""
import argparse
import sys
from pathlib import Path

try:
    import rhino3dm
    import trimesh
    import numpy as np
except ImportError:
    print("Install dependencies: pip install rhino3dm trimesh numpy")
    sys.exit(1)

def convert_mesh_to_3dm(input_path: str, output_path: str = None,
                         scale: float = 1.0, center: bool = False,
                         fix_up_axis: bool = True):
    """Convert a mesh file to Rhino 3DM format."""
    input_path = Path(input_path)
    if output_path is None:
        output_path = input_path.with_suffix('.3dm')

    # Load with trimesh (handles OBJ, GLB, STL, PLY)
    scene = trimesh.load(str(input_path))

    # Handle scenes vs single meshes
    if isinstance(scene, trimesh.Scene):
        meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
    else:
        meshes = [scene]

    # Create 3DM file
    model = rhino3dm.File3dm()
    model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters

    for tm_mesh in meshes:
        if fix_up_axis:
            # Swap Y-up to Z-up: rotate -90 degrees around X
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

        model.Objects.AddMesh(rh_mesh)

    model.Write(str(output_path), 8)
    print(f"Written: {output_path}")
    print(f"  Meshes: {len(meshes)}")
    for i, m in enumerate(meshes):
        print(f"  Mesh {i}: {len(m.vertices)} vertices, {len(m.faces)} faces")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Input mesh file (OBJ, GLB, STL, PLY)")
    parser.add_argument("--output", "-o", help="Output 3DM file path")
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--center", action="store_true")
    parser.add_argument("--no-fix-up", action="store_true")
    args = parser.parse_args()
    convert_mesh_to_3dm(args.input, args.output, args.scale, args.center, not args.no_fix_up)
```

**scripts/inspect_model.py** (key logic):

```python
#!/usr/bin/env python3
"""Inspect a 3D model file and report statistics."""
import sys
from pathlib import Path
import trimesh

def inspect(path: str):
    p = Path(path)
    print(f"File: {p.name}")
    print(f"Format: {p.suffix}")
    print(f"Size: {p.stat().st_size / 1024:.1f} KB")

    scene = trimesh.load(str(p))
    meshes = [scene] if isinstance(scene, trimesh.Trimesh) else list(scene.geometry.values())

    total_verts, total_faces = 0, 0
    for i, m in enumerate(meshes):
        if not isinstance(m, trimesh.Trimesh):
            continue
        print(f"\nMesh {i}:")
        print(f"  Vertices: {len(m.vertices)}")
        print(f"  Faces: {len(m.faces)}")
        print(f"  Bounds: {m.bounds.tolist()}")
        print(f"  Extents: {m.extents.tolist()}")
        print(f"  Watertight: {m.is_watertight}")
        print(f"  Volume: {m.volume:.4f}" if m.is_watertight else "  Volume: N/A (not watertight)")
        total_verts += len(m.vertices)
        total_faces += len(m.faces)

    print(f"\nTotal: {total_verts} vertices, {total_faces} faces, {len(meshes)} mesh(es)")

if __name__ == "__main__":
    inspect(sys.argv[1])
```

**MCP Servers Needed**: None required. The skill uses Python scripts with `rhino3dm` and `trimesh` libraries. If Rhino.Compute is available, an MCP server wrapping the Compute REST API could enable advanced operations (boolean operations, mesh repair, NURBS fitting).

---

### Skill 2: `rhino-sketch-building` -- Sketch Building Outlines from Natural Language

**Purpose**: Translate natural language descriptions of buildings into Rhino geometry (footprints, extrusions, roofs, floors).

**Rhino APIs Used**:
- `rhino3dm` (Python) for geometry creation and 3DM output
- Optionally Rhino.Compute for advanced operations (booleans, fillets)

**Implementation**:

```
~/.claude/skills/rhino-sketch-building/
├── SKILL.md
├── scripts/
│   ├── building_generator.py  # Parametric building geometry
│   ├── primitives.py          # Reusable shape functions
│   └── requirements.txt       # rhino3dm, numpy, shapely
└── examples/
    ├── simple_house.md
    └── office_tower.md
```

**SKILL.md**:

```yaml
---
name: rhino-sketch-building
description: >
  Create building geometry in Rhino from natural language descriptions. Generates
  footprints, extrusions, floors, roofs, and openings. Use when the user describes
  a building, asks to sketch an outline, create massing, or generate architectural
  geometry programmatically.
allowed-tools: Bash(python *), Read, Write, Edit
effort: high
---

# Sketch Building Outlines in Rhino

You translate natural language building descriptions into Rhino 3DM geometry.

## Process

1. **Parse the description**: Extract from the user's description:
   - Footprint shape (rectangular, L-shaped, U-shaped, circular, custom polygon)
   - Dimensions (width, depth, height or number of floors)
   - Floor-to-floor height (default 3.5m if not specified)
   - Roof type (flat, gable, hip, shed -- default flat)
   - Notable features (courtyard, setbacks, cantilevers)
   - Orientation and site context if given

2. **Generate a Python script**: Write a Python script using rhino3dm that creates
   the geometry. Use the primitives library at `${CLAUDE_SKILL_DIR}/scripts/primitives.py`.

3. **Execute and produce 3DM**: Run the script to generate the output file.

4. **Report**: Describe what was created, with dimensions and layer organization.

## Geometry Conventions

- Unit system: **Meters**
- Origin: Building corner at (0,0,0) unless site context given
- Z-up coordinate system (Rhino standard)
- Organize by layers:
  - `Building/Footprint` -- 2D outline curve
  - `Building/Massing` -- 3D extrusion/brep
  - `Building/Floors` -- Floor plate surfaces
  - `Building/Roof` -- Roof geometry
  - `Building/Openings` -- Window/door outlines if specified

## Example Translations

**"A 20m x 12m rectangular office building, 4 stories"**
→ Rectangle footprint, extrude to 14m (4 x 3.5m), 4 floor plates

**"An L-shaped house, main wing 15x8m, side wing 10x6m, 2 stories with a gable roof"**
→ L-shaped polygon, extrude to 7m, add gable roof surface on main wing

**"A circular tower, 10m diameter, 30 floors"**
→ Circle footprint r=5m, extrude to 105m, 30 floor plates

## Generating the Script

Write a complete Python script that:
1. Imports rhino3dm and numpy
2. Creates a File3dm instance
3. Sets up layers with colors
4. Creates the footprint as a curve on the XY plane
5. Extrudes to create massing
6. Adds floor plates at each level
7. Adds roof geometry
8. Writes the output 3DM file

Use these rhino3dm patterns:

```python
import rhino3dm
import math

model = rhino3dm.File3dm()
model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters

# Create layers
layer = rhino3dm.Layer()
layer.Name = "Building/Massing"
layer.Color = (200, 200, 200, 255)
layer_index = model.Layers.Add(layer)

# Create a rectangular footprint
pts = [
    rhino3dm.Point3d(0, 0, 0),
    rhino3dm.Point3d(20, 0, 0),
    rhino3dm.Point3d(20, 12, 0),
    rhino3dm.Point3d(0, 12, 0),
    rhino3dm.Point3d(0, 0, 0),  # close the curve
]
polyline = rhino3dm.Polyline(len(pts))
for p in pts:
    polyline.Add(p.X, p.Y, p.Z)
curve = polyline.ToPolylineCurve()

# Extrude to create massing
extrusion = rhino3dm.Extrusion.Create(
    curve, height=14.0, cap=True
)

# Add objects with layer attributes
attr = rhino3dm.ObjectAttributes()
attr.LayerIndex = layer_index
model.Objects.Add(extrusion, attr)

model.Write("building.3dm", 8)
```
```

**scripts/primitives.py** (reusable building blocks):

```python
#!/usr/bin/env python3
"""Reusable geometry primitives for building generation."""
import rhino3dm
import math


def make_rectangle(width, depth, origin=(0, 0, 0)):
    """Create a closed rectangular polyline on the XY plane."""
    ox, oy, oz = origin
    pts = [
        (ox, oy, oz), (ox + width, oy, oz),
        (ox + width, oy + depth, oz), (ox, oy + depth, oz),
        (ox, oy, oz),
    ]
    pl = rhino3dm.Polyline(len(pts))
    for x, y, z in pts:
        pl.Add(x, y, z)
    return pl.ToPolylineCurve()


def make_l_shape(w1, d1, w2, d2, origin=(0, 0, 0)):
    """Create an L-shaped closed polyline."""
    ox, oy, oz = origin
    pts = [
        (ox, oy, oz), (ox + w1, oy, oz), (ox + w1, oy + d2, oz),
        (ox + w2, oy + d2, oz), (ox + w2, oy + d1, oz),
        (ox, oy + d1, oz), (ox, oy, oz),
    ]
    pl = rhino3dm.Polyline(len(pts))
    for x, y, z in pts:
        pl.Add(x, y, z)
    return pl.ToPolylineCurve()


def make_circle(radius, center=(0, 0, 0), segments=64):
    """Create a circular polyline approximation."""
    pts = []
    for i in range(segments + 1):
        angle = 2 * math.pi * i / segments
        x = center[0] + radius * math.cos(angle)
        y = center[1] + radius * math.sin(angle)
        pts.append((x, y, center[2]))
    pl = rhino3dm.Polyline(len(pts))
    for x, y, z in pts:
        pl.Add(x, y, z)
    return pl.ToPolylineCurve()


def add_layer(model, name, color=(200, 200, 200, 255)):
    """Add a layer to the model and return its index."""
    layer = rhino3dm.Layer()
    layer.Name = name
    layer.Color = color
    return model.Layers.Add(layer)


def add_floor_plates(model, footprint_pts, floor_height, num_floors, layer_index):
    """Add horizontal floor surfaces at each level."""
    attr = rhino3dm.ObjectAttributes()
    attr.LayerIndex = layer_index
    for i in range(num_floors + 1):
        z = i * floor_height
        pts = [(x, y, z) for x, y, _ in footprint_pts]
        pl = rhino3dm.Polyline(len(pts))
        for x, y, z in pts:
            pl.Add(x, y, z)
        model.Objects.Add(pl.ToPolylineCurve(), attr)
```

**MCP Servers Needed**: None for basic massing. For advanced operations (boolean subtraction for courtyards, fillet edges, NURBS surfaces for curved facades), a **Rhino.Compute MCP server** would be valuable. This would wrap the Compute REST API endpoints to allow Claude to call operations like `Brep.CreateBooleanDifference`, `BrepFace.CreateFilletSurface`, etc.

---

### Skill 3: `rhino-explain-geometry` -- Explain Geometry in Natural Language

**Purpose**: Read a Rhino 3DM file and produce a human-readable description of its contents -- dimensions, topology, spatial relationships, materials, layers.

**Rhino APIs Used**:
- `rhino3dm` (Python) for reading geometry and extracting properties
- `numpy` for spatial analysis

**Implementation**:

```
~/.claude/skills/rhino-explain-geometry/
├── SKILL.md
├── scripts/
│   ├── analyze_3dm.py       # Core analysis engine
│   └── requirements.txt     # rhino3dm, numpy
└── examples/
    └── sample_output.md
```

**SKILL.md**:

```yaml
---
name: rhino-explain-geometry
description: >
  Read a Rhino 3DM file and describe its geometry in natural language. Reports
  dimensions, object types, spatial relationships, layer organization, and
  topology. Use when the user asks "what's in this file", "describe this model",
  "how big is this", or wants to understand Rhino geometry without opening Rhino.
allowed-tools: Bash(python *), Read
---

# Explain Rhino Geometry in Natural Language

You read Rhino 3DM files and describe their contents in clear, non-technical language.

## Process

1. **Run the analysis script**:
   ```bash
   python ${CLAUDE_SKILL_DIR}/scripts/analyze_3dm.py "$ARGUMENTS"
   ```

2. **Interpret the output** and write a natural language description covering:

   ### File Overview
   - Number of objects, layers, and named views
   - Unit system and overall bounding box (give real-world scale comparisons)
   - File version and any metadata

   ### Layer Organization
   - List layers and what they contain
   - Identify organizational patterns (e.g., "Architecture/Walls", "Structure/Columns")

   ### Geometry Description
   For each significant object or group:
   - What type it is (mesh, surface, curve, point cloud, etc.)
   - Approximate dimensions (length, width, height)
   - Position relative to other objects
   - Notable properties (open/closed, planar/3D, degree for NURBS)

   ### Spatial Relationships
   - What objects are adjacent, overlapping, or contained within others
   - Overall composition (is this a building? a product? a landscape?)
   - Symmetry, repetition, or patterns

   ### Scale Assessment
   - Based on dimensions and unit system, what real-world object this likely represents
   - Flag anything that seems unusual (e.g., a "building" that is 2mm tall)

## Vocabulary Guide
Translate technical terms:
- Brep → "solid shape" or "surface model"
- NURBS curve → "smooth curve"
- Mesh → "triangulated surface" (mention vertex/face count for complexity)
- Extrusion → "extruded shape" (describe the profile and direction)
- Polysurface → "shape made of multiple joined surfaces"
- Closed solid → "watertight solid that could be 3D printed"
- Open surface → "a surface with exposed edges (like a sheet)"
```

**scripts/analyze_3dm.py**:

```python
#!/usr/bin/env python3
"""Analyze a Rhino 3DM file and output structured information."""
import sys
import json
from pathlib import Path
import rhino3dm


def analyze(path: str):
    model = rhino3dm.File3dm.Read(path)
    if model is None:
        print(f"ERROR: Could not read {path}")
        sys.exit(1)

    p = Path(path)
    info = {
        "file": p.name,
        "size_kb": round(p.stat().st_size / 1024, 1),
        "unit_system": str(model.Settings.ModelUnitSystem),
        "layers": [],
        "objects": [],
        "summary": {
            "total_objects": len(model.Objects),
            "by_type": {},
        },
    }

    # Layers
    for i in range(model.Layers.Count):
        layer = model.Layers[i]
        info["layers"].append({
            "index": i,
            "name": layer.Name,
            "full_path": layer.FullPath if hasattr(layer, 'FullPath') else layer.Name,
            "color": str(layer.Color),
            "visible": layer.Visible,
        })

    # Objects
    type_counts = {}
    for obj in model.Objects:
        geo = obj.Geometry
        geo_type = type(geo).__name__
        type_counts[geo_type] = type_counts.get(geo_type, 0) + 1

        obj_info = {
            "type": geo_type,
            "layer_index": obj.Attributes.LayerIndex,
        }

        # Bounding box
        try:
            bbox = geo.GetBoundingBox()
            obj_info["bbox_min"] = [round(bbox.Min.X, 3), round(bbox.Min.Y, 3), round(bbox.Min.Z, 3)]
            obj_info["bbox_max"] = [round(bbox.Max.X, 3), round(bbox.Max.Y, 3), round(bbox.Max.Z, 3)]
            dx = bbox.Max.X - bbox.Min.X
            dy = bbox.Max.Y - bbox.Min.Y
            dz = bbox.Max.Z - bbox.Min.Z
            obj_info["dimensions"] = [round(dx, 3), round(dy, 3), round(dz, 3)]
        except Exception:
            pass

        # Type-specific info
        if isinstance(geo, rhino3dm.Mesh):
            obj_info["vertices"] = len(geo.Vertices)
            obj_info["faces"] = len(geo.Faces)
        elif isinstance(geo, rhino3dm.Brep):
            obj_info["faces_count"] = geo.Faces.Count
            obj_info["edges_count"] = geo.Edges.Count
            obj_info["is_solid"] = geo.IsSolid
        elif isinstance(geo, rhino3dm.Curve):
            obj_info["is_closed"] = geo.IsClosed
            obj_info["degree"] = geo.Degree if hasattr(geo, 'Degree') else None
            try:
                obj_info["length"] = round(geo.GetLength(), 3)
            except Exception:
                pass
        elif isinstance(geo, rhino3dm.Extrusion):
            obj_info["is_capped"] = True  # approximate
        elif isinstance(geo, rhino3dm.PointCloud):
            obj_info["point_count"] = geo.Count

        # Name
        if obj.Attributes.Name:
            obj_info["name"] = obj.Attributes.Name

        info["objects"].append(obj_info)

    info["summary"]["by_type"] = type_counts

    # Overall bounding box
    all_mins = [o["bbox_min"] for o in info["objects"] if "bbox_min" in o]
    all_maxs = [o["bbox_max"] for o in info["objects"] if "bbox_max" in o]
    if all_mins and all_maxs:
        info["summary"]["overall_bbox_min"] = [
            round(min(m[i] for m in all_mins), 3) for i in range(3)
        ]
        info["summary"]["overall_bbox_max"] = [
            round(max(m[i] for m in all_maxs), 3) for i in range(3)
        ]
        info["summary"]["overall_dimensions"] = [
            round(info["summary"]["overall_bbox_max"][i] - info["summary"]["overall_bbox_min"][i], 3)
            for i in range(3)
        ]

    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    analyze(sys.argv[1])
```

**MCP Servers Needed**: None. This skill is purely analytical and works with `rhino3dm` alone.

---

## Part 4: Optional MCP Server for Rhino.Compute

For advanced operations beyond what `rhino3dm` can do standalone (boolean operations, mesh repair, NURBS surface fitting, Grasshopper definition solving), you could build an MCP server that wraps Rhino.Compute:

```
rhino-compute-mcp/
├── server.py          # MCP server implementation
├── requirements.txt   # mcp, requests
└── README.md
```

This server would expose tools like:
- `rhino_compute_mesh_boolean(operation, mesh_a_path, mesh_b_path)` -- Boolean union/difference/intersection
- `rhino_compute_solve_gh(definition_path, inputs)` -- Solve a Grasshopper definition
- `rhino_compute_convert(input_path, output_format)` -- Convert between file formats
- `rhino_compute_mesh_repair(mesh_path)` -- Repair non-manifold meshes

Each tool would make HTTP calls to the Rhino.Compute REST API running locally or on a cloud server.

This is optional -- the three skills above work with just `rhino3dm` and `trimesh` (no Rhino installation needed). The MCP server adds power when Rhino.Compute is available.

---

## Part 5: Setup Instructions

### Prerequisites

```bash
# Install Python dependencies for all skills
pip install rhino3dm trimesh numpy shapely

# Create skill directories
mkdir -p ~/.claude/skills/rhino-import-comfyui/scripts
mkdir -p ~/.claude/skills/rhino-sketch-building/scripts
mkdir -p ~/.claude/skills/rhino-explain-geometry/scripts
```

### Quick Test

```bash
# Test rhino3dm installation
python -c "import rhino3dm; m = rhino3dm.File3dm(); print('rhino3dm OK')"

# Test trimesh installation
python -c "import trimesh; print('trimesh OK')"
```

### Optional: Rhino.Compute (for advanced features)

1. Install Rhino 8 on Windows
2. Clone `https://github.com/mcneel/compute.rhino3d`
3. Build and run -- serves on `http://localhost:6500`
4. Skills can then call Compute endpoints for operations beyond rhino3dm's capabilities

---

## Summary Table

| Skill | Purpose | Rhino API | Requires Rhino? | Invocation |
|-------|---------|-----------|-----------------|------------|
| `rhino-import-comfyui` | Import AI-generated 3D models | rhino3dm + trimesh | No | `/rhino-import-comfyui <path>` |
| `rhino-sketch-building` | Generate building geometry from text | rhino3dm | No | `/rhino-sketch-building` |
| `rhino-explain-geometry` | Describe 3DM file contents | rhino3dm | No | `/rhino-explain-geometry <path>` |

All three skills work standalone with just Python packages (`pip install rhino3dm trimesh numpy`). No Rhino installation is required for basic functionality. Rhino.Compute adds advanced capabilities (booleans, format conversion, Grasshopper solving) when available.
