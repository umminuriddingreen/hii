#!/bin/bash
# Newark NJ 40x60 Residential House — Full Pipeline
# Generates geometry in Rhino + renders via ComfyUI
set -e

TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${TOOL_DIR}/output"
mkdir -p "$OUT_DIR"

echo "=== Newark NJ 40x60 House Generator ==="
echo ""

# Step 1: Validate zoning compliance
echo "--- Step 1: Zoning Validation ---"
python3 "$TOOL_DIR/newark_house_rhino.py" --validate-only
echo ""

# Step 2: Generate main house geometry
echo "--- Step 2: Generate House Geometry ---"
if python3 -c "import rhino3dm" 2>/dev/null; then
    python3 "$TOOL_DIR/newark_house_rhino.py" -o "$OUT_DIR/newark_house.3dm"
    echo "  → $OUT_DIR/newark_house.3dm"
else
    python3 "$TOOL_DIR/newark_house_rhino.py" --rhinoscript -o "$OUT_DIR/newark_house.py"
    echo "  → $OUT_DIR/newark_house.py (load in Rhino: RunPythonScript)"
fi
echo ""

# Step 3: Generate 5 parametric iterations
echo "--- Step 3: Generate Iterations ---"
python3 "$TOOL_DIR/newark_house_rhino.py" --iterations 5 --iter-dir "$OUT_DIR/iterations"
echo ""

# Step 4: ComfyUI renders
echo "--- Step 4: ComfyUI Renders ---"
python3 "$TOOL_DIR/render_comfyui.py" --all-styles --seed 42
echo ""

echo "=== Pipeline Complete ==="
echo "Output: $OUT_DIR/"
