---
name: rhino-explain-geometry
description: >
  Read a Rhino 3DM file and describe its geometry in natural language. Use when user
  asks what's in a 3DM file, wants to describe a model, or needs geometry analysis.
allowed-tools: Bash(python *), Read
user-invocable: true
---

# Explain Rhino Geometry in Natural Language

Read 3DM files and produce human-readable descriptions.

## Usage

```
/rhino-explain-geometry <3dm_path>
```

## Steps

1. Analyze the file:
   ```bash
   python -c "
   import rhino3dm, json, sys
   model = rhino3dm.File3dm.Read('$0')
   info = {'layers': [], 'objects': [], 'unit': str(model.Settings.ModelUnitSystem)}
   for i in range(model.Layers.Count):
       l = model.Layers[i]
       info['layers'].append({'name': l.Name, 'visible': l.Visible})
   for obj in model.Objects:
       g = obj.Geometry
       bbox = g.GetBoundingBox()
       info['objects'].append({
           'type': type(g).__name__,
           'name': obj.Attributes.Name or '',
           'dims': [round(bbox.Max.X-bbox.Min.X,2), round(bbox.Max.Y-bbox.Min.Y,2), round(bbox.Max.Z-bbox.Min.Z,2)]
       })
   print(json.dumps(info, indent=2))
   "
   ```

2. Describe in plain language: object types, dimensions, spatial relationships, what the model likely represents.

3. Use architectural vocabulary when the geometry suggests buildings/structures.
