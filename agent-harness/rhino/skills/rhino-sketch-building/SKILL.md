---
name: rhino-sketch-building
description: >
  Generate building geometry in Rhino 3DM from natural language descriptions.
  Creates footprints, extrusions, floor plates. Use when user describes a building
  form and wants geometry created programmatically.
allowed-tools: Bash(python *), Read, Write, Edit
user-invocable: true
effort: high
---

# Sketch Building Geometry from Natural Language

Translate architectural descriptions into Rhino 3DM geometry using rhino3dm.

## Usage

```
/rhino-sketch-building <description>
```

## Process

1. Parse the user's description for: shape, dimensions, height/floors, features.

2. Write a Python script using `rhino3dm` that creates the geometry:
   - Use `rhino3dm.UnitSystem.Meters`
   - Organize by layers: `Building/Footprint`, `Building/Massing`, `Building/Floors`
   - Create polyline footprints, extrusions for massing, floor plates at each level

3. Execute the script to produce a 3DM file.

4. Report what was created with dimensions.

## rhino3dm Patterns

```python
import rhino3dm
model = rhino3dm.File3dm()
model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters

# Layers
layer = rhino3dm.Layer()
layer.Name = "Building/Massing"
layer.Color = (200, 200, 200, 255)
idx = model.Layers.Add(layer)

# Rectangle footprint
pts = [rhino3dm.Point3d(0,0,0), rhino3dm.Point3d(w,0,0),
       rhino3dm.Point3d(w,d,0), rhino3dm.Point3d(0,d,0), rhino3dm.Point3d(0,0,0)]
pl = rhino3dm.Polyline(len(pts))
for p in pts: pl.Add(p.X, p.Y, p.Z)
curve = pl.ToPolylineCurve()

# Extrusion
ext = rhino3dm.Extrusion.Create(curve, height, True)
attr = rhino3dm.ObjectAttributes()
attr.LayerIndex = idx
model.Objects.Add(ext, attr)

model.Write("output.3dm", 8)
```
