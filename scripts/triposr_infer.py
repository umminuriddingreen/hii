#!/usr/bin/env python3
"""Direct TripoSR inference for HII with MPS support on Apple Silicon."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import rembg
import torch
from PIL import Image

HII_ROOT = Path(__file__).resolve().parents[1]
TRIPOSR_ROOT = Path(os.environ.get("TRIPOSR_ROOT", HII_ROOT / "external" / "TripoSR")).expanduser()
if str(TRIPOSR_ROOT) not in sys.path:
    sys.path.insert(0, str(TRIPOSR_ROOT))

from tsr.system import TSR
from tsr.utils import remove_background, resize_foreground


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda:0"
    return "cpu"


def main() -> int:
    ap = argparse.ArgumentParser(description="Run direct TripoSR inference")
    ap.add_argument("image", help="Input image path")
    ap.add_argument("--output-dir", default="/tmp/hii-triposr-output", help="Directory for outputs")
    ap.add_argument("--model", default="stabilityai/TripoSR", help="HF model id or local model path")
    ap.add_argument("--device", default=None, help="mps|cuda:0|cpu")
    ap.add_argument("--foreground-ratio", type=float, default=0.85)
    ap.add_argument("--mc-resolution", type=int, default=256)
    ap.add_argument("--chunk-size", type=int, default=8192)
    ap.add_argument("--format", choices=["obj", "glb"], default="glb")
    ap.add_argument("--no-remove-bg", action="store_true")
    ns = ap.parse_args()

    output_dir = Path(ns.output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    image_path = Path(ns.image).expanduser()
    if not image_path.exists():
      raise FileNotFoundError(f"Input image not found: {image_path}")

    device = ns.device or pick_device()
    model = TSR.from_pretrained(
        ns.model,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    model.renderer.set_chunk_size(ns.chunk_size)
    model.to(device)

    if ns.no_remove_bg:
        image = Image.open(image_path).convert("RGB")
    else:
        rembg_session = rembg.new_session()
        image = remove_background(Image.open(image_path), rembg_session)
        image = resize_foreground(image, ns.foreground_ratio)
        image = np.array(image).astype(np.float32) / 255.0
        image = image[:, :, :3] * image[:, :, 3:4] + (1 - image[:, :, 3:4]) * 0.5
        image = Image.fromarray((image * 255.0).astype(np.uint8))
        image.save(output_dir / "input.png")

    with torch.no_grad():
        scene_codes = model([image], device=device)
        meshes = model.extract_mesh(scene_codes, True, resolution=ns.mc_resolution)

    mesh_path = output_dir / f"mesh.{ns.format}"
    meshes[0].export(mesh_path)
    print(json.dumps({
        "status": "ok",
        "device": device,
        "image": str(image_path),
        "output_dir": str(output_dir),
        "mesh": str(mesh_path),
        "model": ns.model,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
