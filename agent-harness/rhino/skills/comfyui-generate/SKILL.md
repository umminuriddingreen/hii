---
name: comfyui-generate
description: >
  Send a 2D image to ComfyUI for image-to-3D generation. Use when user wants to
  generate a 3D model from a sketch, diagram, or photo using ComfyUI with Wan 2.1,
  TripoSR, or other image-to-3D nodes.
allowed-tools: Bash(python *), Read, Write, Glob
user-invocable: true
---

# Generate 3D Model from 2D Image via ComfyUI

Send images to ComfyUI's local API for image-to-3D conversion.

## Usage

```
/comfyui-generate <image_path> [workflow_json_path]
```

## Steps

1. Run the generation script:
   ```bash
   python ${CLAUDE_SKILL_DIR}/../../scripts/comfyui_generate.py "$0" --workflow "$1"
   ```

2. If ComfyUI isn't running, guide the user to:
   - Start ComfyUI (`cd ~/ComfyUI && python main.py`)
   - Or use web alternatives (TripoSR, Meshy.ai) and save OBJ/GLB manually

3. Once the 3D output is downloaded, offer to convert to Rhino 3DM:
   ```bash
   python ${CLAUDE_SKILL_DIR}/../../scripts/convert_to_3dm.py <output_mesh>
   ```
