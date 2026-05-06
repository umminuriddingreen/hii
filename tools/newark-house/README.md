# Newark House Tool

This tool captures the architectural workflow from Codex thread `019dfcec-168e-7af1-bd53-755c0b2e38d3`.

It creates a code-aware 40 ft by 60 ft Newark, NJ residential house study using:

- Newark-style R-1/R-2 residential assumptions.
- NJ Uniform Construction Code dimensional checks.
- Rhino/rhino3dm geometry generation.
- RhinoScript Python export for live Rhino execution.
- Parametric iteration generation.
- ComfyUI render workflow generation.

## Included Logic

- Lot: 40 ft by 60 ft.
- Conservative zoning baseline:
  - front setback: 25 ft
  - side setback: 5 ft each side
  - rear setback: 20 ft
  - max height: 35 ft
  - max lot coverage: 40 percent
- Building baseline:
  - 28 ft by 14 ft main footprint
  - 2 stories plus attic
  - basement/foundation depth
  - front porch
  - gable roof
  - windows, front door, steps, chimney, porch columns
- Code checks:
  - ceiling height
  - stair width, riser, tread
  - egress window area
  - height and lot coverage

The original chat noted that Newark R-2 or R-3 may be more likely than R-1 on a 40 by 60 lot. This tool keeps the conservative baseline and exposes parameters for iteration.

## Run

```bash
cd tools/newark-house
python3.11 -m pip install rhino3dm
./run.sh
```

Validate only:

```bash
python3.11 newark_house_rhino.py --validate-only
```

Create a `.3dm` file:

```bash
python3.11 newark_house_rhino.py -o output/newark_house.3dm
```

Create RhinoScript instead of a standalone `.3dm`:

```bash
python3.11 newark_house_rhino.py --rhinoscript -o output/newark_house.py
```

Create iterations:

```bash
python3.11 newark_house_rhino.py --iterations 5 --iter-dir output/iterations
```

Generate ComfyUI workflows without a running ComfyUI server:

```bash
python3.11 render_comfyui.py --all-styles
```

Submit all render styles to a running ComfyUI instance:

```bash
COMFYUI_URL=http://127.0.0.1:8188 python3.11 render_comfyui.py --all-styles --seed 42
```

## Outputs

Generated files go under `tools/newark-house/output/` and are intentionally ignored by git. Commit the source scripts and workflow templates, not generated `.3dm`, PNG, or temporary Rhino output.
