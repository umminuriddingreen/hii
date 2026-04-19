---
name: rhino-import-comfyui
description: >
  Convert OBJ/GLB/STL/PLY mesh files to Rhino 3DM format. Use when user has an
  AI-generated 3D model and wants to import it into Rhino for refinement.
allowed-tools: Bash(python *), Read, Glob
user-invocable: true
---

# Import 3D Mesh into Rhino 3DM

Convert AI-generated meshes to Rhino 3DM format with proper axis orientation and scaling.

## Usage

```
/rhino-import-comfyui <mesh_path> [--scale <factor>] [--center]
```

## Steps

1. Inspect the mesh:
   ```bash
   python ${CLAUDE_SKILL_DIR}/../../scripts/convert_to_3dm.py "$0" --inspect
   ```

2. Convert to 3DM:
   ```bash
   python ${CLAUDE_SKILL_DIR}/../../scripts/convert_to_3dm.py "$0" --center
   ```

3. Report the results: dimensions, vertex/face count, watertight status.

4. Remind user to open the 3DM in Rhino 8 and run the refinement script at
   `rhino_scripts/refine_mesh.py` for cleanup, scaling, and material assignment.
