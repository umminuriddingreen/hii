#!/usr/bin/env python3
"""
ComfyUI Rendering Pipeline for Newark House
=============================================
Submits render workflows to ComfyUI for architectural visualization.
Supports txt2img (concept renders) and img2img (from Rhino viewport captures).

Usage:
  python render_comfyui.py --txt2img                    # Generate concept render
  python render_comfyui.py --img2img viewport.png       # Render from viewport capture
  python render_comfyui.py --batch 4                    # Generate 4 angle variations
  python render_comfyui.py --iterations iterations/     # Render all .3dm iterations
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from urllib import error, request

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
OUTPUT_DIR = Path(os.environ.get("COMFYUI_OUTPUT", os.path.expanduser("~/Documents/ComfyUI/output")))


# ---------------------------------------------------------------------------
# Prompt library — Newark NJ residential styles
# ---------------------------------------------------------------------------

STYLE_PROMPTS = {
    "exterior_front": (
        "photorealistic architectural photograph, Newark New Jersey colonial house, "
        "two-story with attic, front porch with white columns, gable roof with asphalt shingles, "
        "brick and vinyl siding, painted trim, residential street, sidewalk, "
        "mature oak trees, green lawn, golden hour warm lighting, "
        "DSLR photograph, 35mm lens, high detail, 8k resolution"
    ),
    "exterior_34": (
        "photorealistic architectural rendering, three-quarter view, "
        "Newark NJ colonial home, two-story brick house, covered front porch, "
        "pitched roof, chimney, double-hung windows with shutters, "
        "driveway, chain-link fence, urban residential neighborhood, "
        "afternoon sunlight, professional real estate photography, 8k"
    ),
    "exterior_rear": (
        "photorealistic rear view of Newark NJ colonial house, "
        "two-story with small backyard, rear windows, chimney visible, "
        "wooden deck, chain-link fence, neighboring houses visible, "
        "afternoon light, residential neighborhood, 8k"
    ),
    "interior_living": (
        "photorealistic interior photograph, colonial style living room, "
        "hardwood floors, crown molding, double-hung windows with natural light, "
        "traditional furniture, warm color palette, "
        "DSLR photograph, wide angle 16mm, interior design magazine quality, 8k"
    ),
    "aerial": (
        "photorealistic aerial drone photograph, Newark NJ residential block, "
        "colonial houses, 40x60 foot lots, tree-lined streets, "
        "urban residential grid, golden hour, 8k"
    ),
    "night": (
        "photorealistic night photograph, Newark NJ colonial house, "
        "warm interior lights glowing through windows, front porch light, "
        "street lamp, blue hour sky, wet pavement reflection, "
        "moody atmosphere, professional architecture photography, 8k"
    ),
}

NEGATIVE_PROMPT = (
    "cartoon, anime, sketch, wireframe, low quality, blurry, deformed, "
    "ugly, watermark, text, oversaturated, unrealistic, floating objects, "
    "extra limbs, bad architecture, impossible geometry"
)


# ---------------------------------------------------------------------------
# Workflow builders
# ---------------------------------------------------------------------------

def txt2img_workflow(
    prompt: str,
    negative: str = NEGATIVE_PROMPT,
    seed: int = -1,
    steps: int = 30,
    cfg: float = 7.5,
    width: int = 1216,
    height: int = 832,
    checkpoint: str = "sd_xl_base_1.0.safetensors",
    prefix: str = "newark_house",
) -> dict:
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": checkpoint}},
        "2": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed, "steps": steps, "cfg": cfg,
                "sampler_name": "euler_ancestral", "scheduler": "normal",
                "denoise": 1.0,
                "model": ["1", 0], "positive": ["2", 0],
                "negative": ["3", 0], "latent_image": ["4", 0],
            },
        },
        "6": {"class_type": "VAEDecode",
              "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": prefix, "images": ["6", 0]}},
    }


def img2img_workflow(
    image_name: str,
    prompt: str,
    negative: str = NEGATIVE_PROMPT,
    seed: int = -1,
    steps: int = 30,
    cfg: float = 7.5,
    denoise: float = 0.55,
    checkpoint: str = "sd_xl_base_1.0.safetensors",
    prefix: str = "newark_house_render",
) -> dict:
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": checkpoint}},
        "2": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative, "clip": ["1", 1]}},
        "8": {"class_type": "LoadImage",
              "inputs": {"image": image_name}},
        "9": {"class_type": "VAEEncode",
              "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}},
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed, "steps": steps, "cfg": cfg,
                "sampler_name": "euler_ancestral", "scheduler": "normal",
                "denoise": denoise,
                "model": ["1", 0], "positive": ["2", 0],
                "negative": ["3", 0], "latent_image": ["9", 0],
            },
        },
        "6": {"class_type": "VAEDecode",
              "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": prefix, "images": ["6", 0]}},
    }


# ---------------------------------------------------------------------------
# ComfyUI API interaction
# ---------------------------------------------------------------------------

def submit_workflow(workflow: dict) -> str:
    """Submit workflow to ComfyUI, return prompt_id."""
    payload = json.dumps({"prompt": workflow}).encode("utf-8")
    req = request.Request(
        f"{COMFYUI_URL}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode())
    return result["prompt_id"]


def poll_result(prompt_id: str, timeout_s: int = 180) -> list[str]:
    """Poll for completed images, return list of output filenames."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            req = request.Request(f"{COMFYUI_URL}/history/{prompt_id}", method="GET")
            with request.urlopen(req, timeout=10) as resp:
                history = json.loads(resp.read().decode())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                files = []
                for node_out in outputs.values():
                    for img in node_out.get("images", []):
                        files.append(img.get("filename", ""))
                return files
        except Exception:
            pass
        time.sleep(3)
    return []


def check_comfyui() -> bool:
    """Check if ComfyUI is running."""
    try:
        req = request.Request(f"{COMFYUI_URL}/system_stats", method="GET")
        with request.urlopen(req, timeout=5) as resp:
            resp.read()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Batch rendering
# ---------------------------------------------------------------------------

def render_batch(styles: list[str], seed_base: int = 42) -> list[str]:
    """Render multiple style variations."""
    results = []
    for i, style_key in enumerate(styles):
        prompt = STYLE_PROMPTS.get(style_key, style_key)
        wf = txt2img_workflow(prompt, seed=seed_base + i, prefix=f"newark_{style_key}")
        print(f"[render] Submitting {style_key}...")
        try:
            pid = submit_workflow(wf)
            files = poll_result(pid)
            results.extend(files)
            print(f"[render] {style_key}: {files}")
        except Exception as e:
            print(f"[render] {style_key} failed: {e}")
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="ComfyUI render pipeline for Newark house")
    parser.add_argument("--txt2img", action="store_true", help="Generate concept render")
    parser.add_argument("--img2img", type=str, help="Render from viewport capture image")
    parser.add_argument("--style", type=str, default="exterior_front",
                        choices=list(STYLE_PROMPTS.keys()),
                        help="Render style preset")
    parser.add_argument("--batch", type=int, default=0,
                        help="Render N style variations")
    parser.add_argument("--all-styles", action="store_true",
                        help="Render all style presets")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--cfg", type=float, default=7.5)
    parser.add_argument("--denoise", type=float, default=0.55,
                        help="Denoise strength for img2img")
    parser.add_argument("--checkpoint", type=str,
                        default="sd_xl_base_1.0.safetensors")
    parser.add_argument("--export-workflow", type=str,
                        help="Export workflow JSON instead of submitting")
    args = parser.parse_args()

    # Export mode
    if args.export_workflow:
        prompt = STYLE_PROMPTS[args.style]
        if args.img2img:
            wf = img2img_workflow(args.img2img, prompt, seed=args.seed,
                                  steps=args.steps, cfg=args.cfg,
                                  denoise=args.denoise, checkpoint=args.checkpoint)
        else:
            wf = txt2img_workflow(prompt, seed=args.seed, steps=args.steps,
                                  cfg=args.cfg, checkpoint=args.checkpoint)
        Path(args.export_workflow).write_text(json.dumps(wf, indent=2))
        print(f"Workflow exported to {args.export_workflow}")
        return 0

    # Check ComfyUI
    if not check_comfyui():
        print(f"[error] ComfyUI not running at {COMFYUI_URL}")
        print("  Start ComfyUI first: cd ~/ComfyUI && python main.py")
        # Still export workflows for later use
        out_dir = Path("comfyui_workflows")
        out_dir.mkdir(exist_ok=True)
        styles = list(STYLE_PROMPTS.keys()) if args.all_styles else [args.style]
        for s in styles:
            wf = txt2img_workflow(STYLE_PROMPTS[s], seed=args.seed, prefix=f"newark_{s}")
            (out_dir / f"{s}.json").write_text(json.dumps(wf, indent=2))
        print(f"Exported {len(styles)} workflows to {out_dir}/ for manual submission")
        return 0

    # Batch rendering
    if args.all_styles:
        files = render_batch(list(STYLE_PROMPTS.keys()), args.seed)
        print(f"\nRendered {len(files)} images")
        return 0

    if args.batch > 0:
        styles = list(STYLE_PROMPTS.keys())[:args.batch]
        files = render_batch(styles, args.seed)
        print(f"\nRendered {len(files)} images")
        return 0

    # Single render
    prompt = STYLE_PROMPTS[args.style]
    if args.img2img:
        wf = img2img_workflow(args.img2img, prompt, seed=args.seed,
                              steps=args.steps, cfg=args.cfg,
                              denoise=args.denoise, checkpoint=args.checkpoint)
    else:
        wf = txt2img_workflow(prompt, seed=args.seed, steps=args.steps,
                              cfg=args.cfg, checkpoint=args.checkpoint)

    print(f"[render] Style: {args.style}")
    pid = submit_workflow(wf)
    print(f"[render] Submitted: {pid}")
    files = poll_result(pid)
    print(f"[render] Output: {files}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
