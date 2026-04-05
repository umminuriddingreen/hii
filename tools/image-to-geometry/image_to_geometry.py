#!/usr/bin/env python3
"""
HII Tool: Image to 3D Geometry
===============================
Pipeline: URL -> fetch image -> Ollama vision analysis -> RhinoScript Python generation -> Rhino MCP execution
Optionally bridges viewport capture through ComfyUI img2img for style refinement.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional
from urllib import error, request


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REF_DIR = Path("/tmp/hii-ref-images")
OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("HII_VISION_MODEL", "llava:13b")
CODE_MODEL = os.environ.get("HII_CODE_MODEL", "qwen2.5-coder:14b")
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
RHINO_MCP_SMOKETEST = Path(os.environ.get(
    "RHINO_MCP_SMOKETEST",
    os.path.expanduser("~/dev/agent/rhino_mcp_smoketest.py"),
))
MCP_SERVER_CMD = os.environ.get("MCP_SERVER_CMD", "uvx rhinomcp")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ImageRef:
    url: str
    local_path: Path
    width: int = 0
    height: int = 0


@dataclass
class GeometryAnalysis:
    """Structured output from vision model analysis."""
    overall_shape: str = ""
    dimensions_estimate: str = ""
    proportions: str = ""
    structural_elements: list[str] = field(default_factory=list)
    material_patterns: list[str] = field(default_factory=list)
    symmetry: str = ""
    suggested_approach: str = ""
    raw_description: str = ""


@dataclass
class PipelineResult:
    image_ref: Optional[ImageRef] = None
    analysis: Optional[GeometryAnalysis] = None
    rhino_code: str = ""
    rhino_result: dict[str, Any] = field(default_factory=dict)
    comfyui_output: Optional[str] = None
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 1) Image Fetcher
# ---------------------------------------------------------------------------

def fetch_image(url: str) -> ImageRef:
    """Download an image from a URL and save to the reference directory."""
    REF_DIR.mkdir(parents=True, exist_ok=True)

    # Determine extension from URL or default to .jpg
    ext = ".jpg"
    for candidate in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
        if candidate in url.lower():
            ext = candidate
            break

    filename = f"{uuid.uuid4().hex[:12]}{ext}"
    local_path = REF_DIR / filename

    print(f"[fetch] Downloading {url}")
    req = request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HII/1.0",
    })

    try:
        with request.urlopen(req, timeout=30) as resp:
            data = resp.read()
    except error.URLError as exc:
        raise RuntimeError(f"Failed to download image: {exc}") from exc

    local_path.write_bytes(data)
    print(f"[fetch] Saved to {local_path} ({len(data)} bytes)")

    return ImageRef(url=url, local_path=local_path)


def fetch_image_from_search(query: str) -> ImageRef:
    """Use a local SearXNG instance or fallback: save a placeholder and let the
    vision model work with whatever the user provides."""
    # Try SearXNG for image search
    searxng_url = os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080")
    search_url = f"{searxng_url}/search?q={request.quote(query)}&categories=images&format=json"
    try:
        req = request.Request(search_url, headers={"User-Agent": "HII/1.0"})
        with request.urlopen(req, timeout=15) as resp:
            results = json.loads(resp.read().decode())
        if results.get("results"):
            img_url = results["results"][0].get("img_src") or results["results"][0].get("url")
            if img_url:
                return fetch_image(img_url)
    except Exception as exc:
        print(f"[fetch] SearXNG search failed ({exc}), need direct URL")

    raise RuntimeError(
        f"Could not find image for query '{query}'. Please provide a direct image URL instead."
    )


# ---------------------------------------------------------------------------
# 2) Image Analyzer (Ollama multimodal)
# ---------------------------------------------------------------------------

def image_to_base64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def analyze_image(ref: ImageRef, description: str = "") -> GeometryAnalysis:
    """Send image to Ollama vision model and extract geometric properties."""
    b64 = image_to_base64(ref.local_path)

    context_hint = ""
    if description:
        context_hint = f"\nAdditional context from user: {description}\n"

    prompt = f"""Analyze this image for 3D geometry reconstruction. Extract:
1. **Overall shape**: What is the dominant 3D form? (box, cylinder, organic, etc.)
2. **Dimensions estimate**: Approximate real-world proportions (e.g., "2:1:1 width:height:depth")
3. **Proportions**: Key ratios between parts
4. **Structural elements**: List distinct geometric parts (walls, roof, columns, curves, etc.)
5. **Material patterns**: Surface textures, colors, patterns observed
6. **Symmetry**: Symmetry axes or lack thereof
7. **Suggested modeling approach**: How would you build this in a CAD tool step-by-step?
{context_hint}
Respond in JSON with keys: overall_shape, dimensions_estimate, proportions, structural_elements (array),
material_patterns (array), symmetry, suggested_approach, raw_description."""

    payload = {
        "model": VISION_MODEL,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [b64],
            }
        ],
        "stream": False,
        "options": {"temperature": 0.2},
    }

    print(f"[analyze] Sending image to {VISION_MODEL}...")
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.URLError as exc:
        raise RuntimeError(f"Ollama vision request failed: {exc}") from exc

    content = data.get("message", {}).get("content", "")
    print(f"[analyze] Got response ({len(content)} chars)")

    # Parse the JSON from the model output
    analysis = _parse_analysis(content)
    return analysis


def _parse_analysis(text: str) -> GeometryAnalysis:
    """Best-effort parse of LLM JSON output into GeometryAnalysis."""
    # Try direct JSON parse
    try:
        obj = json.loads(text)
        return _dict_to_analysis(obj)
    except json.JSONDecodeError:
        pass

    # Try extracting JSON from markdown code block
    import re
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group(1))
            return _dict_to_analysis(obj)
        except json.JSONDecodeError:
            pass

    # Try finding first { ... } block
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char == "{":
            try:
                obj, _ = decoder.raw_decode(text[idx:])
                if isinstance(obj, dict):
                    return _dict_to_analysis(obj)
            except json.JSONDecodeError:
                continue

    # Fallback: treat entire text as raw description
    return GeometryAnalysis(raw_description=text)


def _dict_to_analysis(d: dict) -> GeometryAnalysis:
    return GeometryAnalysis(
        overall_shape=str(d.get("overall_shape", "")),
        dimensions_estimate=str(d.get("dimensions_estimate", "")),
        proportions=str(d.get("proportions", "")),
        structural_elements=_ensure_list(d.get("structural_elements", [])),
        material_patterns=_ensure_list(d.get("material_patterns", [])),
        symmetry=str(d.get("symmetry", "")),
        suggested_approach=str(d.get("suggested_approach", "")),
        raw_description=str(d.get("raw_description", "")),
    )


def _ensure_list(val: Any) -> list[str]:
    if isinstance(val, list):
        return [str(v) for v in val]
    if isinstance(val, str):
        return [val]
    return []


# ---------------------------------------------------------------------------
# 3) Geometry Generator — produces RhinoScript Python
# ---------------------------------------------------------------------------

def generate_rhino_code(analysis: GeometryAnalysis, description: str = "") -> str:
    """Use a code-generation LLM to convert the analysis into RhinoScript Python."""
    analysis_json = json.dumps(asdict(analysis), indent=2)

    user_hint = ""
    if description:
        user_hint = f"\nUser description: {description}\n"

    prompt = f"""You are a RhinoScript Python expert. Given the following geometric analysis of an image,
write RhinoScript Python code that recreates the geometry in Rhino.
{user_hint}
Geometric analysis:
{analysis_json}

Rules:
- Use only rhinoscriptsyntax (import rhinoscriptsyntax as rs).
- Center the geometry at the world origin.
- Use real-world scale in millimeters where possible.
- Add layers for different structural elements.
- Add materials/colors where the analysis mentions them.
- Use rs.AddLayer, rs.AddBox, rs.AddCylinder, rs.AddSphere, rs.AddSrfPt, rs.AddLoftSrf, etc.
- The code must be self-contained and runnable.
- Do NOT use rs.GetObject or any interactive/input functions.
- Print a summary of what was created at the end.

Respond with ONLY the Python code, no markdown fences, no explanation."""

    payload = {
        "model": CODE_MODEL,
        "messages": [
            {"role": "system", "content": "You write RhinoScript Python code. Output only valid Python code."},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"temperature": 0.1},
    }

    print(f"[codegen] Generating RhinoScript Python via {CODE_MODEL}...")
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.URLError as exc:
        raise RuntimeError(f"Ollama codegen request failed: {exc}") from exc

    content = data.get("message", {}).get("content", "")

    # Strip markdown fences if the model added them anyway
    code = _strip_code_fences(content)
    print(f"[codegen] Generated {len(code.splitlines())} lines of RhinoScript Python")
    return code


def _strip_code_fences(text: str) -> str:
    """Remove ```python ... ``` wrapping if present."""
    import re
    match = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


# ---------------------------------------------------------------------------
# 4) Rhino MCP Executor
# ---------------------------------------------------------------------------

def execute_in_rhino(code: str, timeout_s: int = 90) -> dict[str, Any]:
    """Execute RhinoScript Python code via the Rhino MCP tool."""
    smoketest = str(RHINO_MCP_SMOKETEST)
    if not Path(smoketest).exists():
        return {"ok": False, "error": f"rhino_mcp_smoketest.py not found at {smoketest}"}

    cmd = [
        sys.executable, smoketest,
        "--server", MCP_SERVER_CMD,
        "--call", "execute_rhinoscript_python_code",
        "--args", json.dumps({"code": code}),
        "--timeout", str(timeout_s),
    ]

    print(f"[rhino] Executing code in Rhino ({len(code.splitlines())} lines)...")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 10)
        result = {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        result = {"ok": False, "error": "Rhino MCP call timed out"}
    except FileNotFoundError:
        result = {"ok": False, "error": "python3 or smoketest script not found"}

    status = "success" if result.get("ok") else "failed"
    print(f"[rhino] Execution {status}")
    return result


# ---------------------------------------------------------------------------
# 5) ComfyUI Bridge (optional img2img refinement)
# ---------------------------------------------------------------------------

def comfyui_img2img(image_path: Path, style_prompt: str = "") -> Optional[str]:
    """Send an image through ComfyUI img2img for style refinement.
    Returns the path to the output image or None on failure."""
    try:
        _check_comfyui()
    except Exception:
        print("[comfyui] ComfyUI not available, skipping style refinement")
        return None

    b64 = image_to_base64(image_path)
    prompt_text = style_prompt or "architectural rendering, high quality, detailed materials"

    # Minimal ComfyUI API workflow for img2img
    workflow = _build_img2img_workflow(b64, prompt_text)

    print(f"[comfyui] Submitting img2img workflow...")
    try:
        payload = {"prompt": workflow}
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            f"{COMFYUI_URL}/prompt",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())

        prompt_id = result.get("prompt_id")
        if not prompt_id:
            print("[comfyui] No prompt_id returned")
            return None

        # Poll for completion
        output_path = _poll_comfyui_result(prompt_id, timeout_s=120)
        return output_path

    except Exception as exc:
        print(f"[comfyui] img2img failed: {exc}")
        return None


def _check_comfyui() -> None:
    req = request.Request(f"{COMFYUI_URL}/system_stats", method="GET")
    with request.urlopen(req, timeout=5) as resp:
        resp.read()


def _build_img2img_workflow(image_b64: str, prompt_text: str) -> dict:
    """Build a minimal ComfyUI img2img workflow dict."""
    return {
        "1": {
            "class_type": "LoadImageBase64",
            "inputs": {"image": image_b64},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": prompt_text,
                "clip": ["4", 1],
            },
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "ugly, blurry, low quality",
                "clip": ["4", 1],
            },
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": 42,
                "steps": 20,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["6", 0],
                "denoise": 0.55,
            },
        },
        "6": {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["1", 0],
                "vae": ["4", 2],
            },
        },
        "7": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["5", 0],
                "vae": ["4", 2],
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["7", 0],
                "filename_prefix": "hii_img2geo",
            },
        },
    }


def _poll_comfyui_result(prompt_id: str, timeout_s: int = 120) -> Optional[str]:
    """Poll ComfyUI history for the completed prompt and return output image path."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            req = request.Request(f"{COMFYUI_URL}/history/{prompt_id}", method="GET")
            with request.urlopen(req, timeout=10) as resp:
                history = json.loads(resp.read().decode())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                for node_id, node_out in outputs.items():
                    images = node_out.get("images", [])
                    if images:
                        img_info = images[0]
                        output_dir = Path(os.path.expanduser("~/Documents/ComfyUI/output"))
                        out_path = output_dir / img_info.get("filename", "")
                        if out_path.exists():
                            print(f"[comfyui] Output: {out_path}")
                            return str(out_path)
                return None
        except Exception:
            pass
        time.sleep(3)
    print("[comfyui] Timed out waiting for result")
    return None


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_pipeline(
    url: Optional[str] = None,
    search: Optional[str] = None,
    description: str = "",
    use_comfyui: bool = False,
    dry_run: bool = False,
    skip_rhino: bool = False,
) -> PipelineResult:
    """Run the full image-to-geometry pipeline."""
    result = PipelineResult()

    # Step 1: Fetch image
    print("\n=== Step 1: Fetch Image ===")
    try:
        if url:
            result.image_ref = fetch_image(url)
        elif search:
            result.image_ref = fetch_image_from_search(search)
        else:
            result.errors.append("No URL or search query provided")
            return result
    except Exception as exc:
        result.errors.append(f"Image fetch failed: {exc}")
        return result

    # Step 2: Analyze image
    print("\n=== Step 2: Analyze Image ===")
    try:
        result.analysis = analyze_image(result.image_ref, description)
        print(f"[analyze] Shape: {result.analysis.overall_shape}")
        print(f"[analyze] Elements: {', '.join(result.analysis.structural_elements)}")
    except Exception as exc:
        result.errors.append(f"Image analysis failed: {exc}")
        return result

    # Step 3: Generate RhinoScript Python
    print("\n=== Step 3: Generate Rhino Code ===")
    try:
        result.rhino_code = generate_rhino_code(result.analysis, description)
    except Exception as exc:
        result.errors.append(f"Code generation failed: {exc}")
        return result

    if dry_run:
        print("\n[dry-run] Skipping Rhino execution. Generated code:")
        print(result.rhino_code)
        return result

    # Step 4: Execute in Rhino
    if not skip_rhino:
        print("\n=== Step 4: Execute in Rhino ===")
        result.rhino_result = execute_in_rhino(result.rhino_code)
    else:
        print("\n=== Step 4: Skipped (--skip-rhino) ===")

    # Step 5: Optional ComfyUI refinement
    if use_comfyui and result.image_ref:
        print("\n=== Step 5: ComfyUI Style Refinement ===")
        style = f"3D rendering of {result.analysis.overall_shape}, architectural visualization"
        result.comfyui_output = comfyui_img2img(result.image_ref.local_path, style)

    # Summary
    print("\n=== Pipeline Complete ===")
    if result.errors:
        print(f"Errors: {result.errors}")
    if result.rhino_result.get("ok"):
        print("Geometry created successfully in Rhino")
    if result.comfyui_output:
        print(f"ComfyUI output: {result.comfyui_output}")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="HII: Convert online image references into Rhino 3D geometry via LLM analysis",
    )
    parser.add_argument("--url", type=str, help="Direct URL to reference image")
    parser.add_argument("--search", type=str, help="Search query to find reference image (requires SearXNG)")
    parser.add_argument("--desc", type=str, default="", help="Optional description/context for the geometry")
    parser.add_argument("--comfyui", action="store_true", help="Enable ComfyUI img2img style refinement")
    parser.add_argument("--dry-run", action="store_true", help="Generate code but don't execute in Rhino")
    parser.add_argument("--skip-rhino", action="store_true", help="Skip Rhino execution step")
    parser.add_argument("--vision-model", type=str, help=f"Ollama vision model (default: {VISION_MODEL})")
    parser.add_argument("--code-model", type=str, help=f"Ollama code model (default: {CODE_MODEL})")
    parser.add_argument("--output-code", type=str, help="Save generated RhinoScript to file")
    args = parser.parse_args()

    if args.vision_model:
        global VISION_MODEL
        VISION_MODEL = args.vision_model
    if args.code_model:
        global CODE_MODEL
        CODE_MODEL = args.code_model

    if not args.url and not args.search:
        parser.error("Provide --url or --search")

    result = run_pipeline(
        url=args.url,
        search=args.search,
        description=args.desc,
        use_comfyui=args.comfyui,
        dry_run=args.dry_run,
        skip_rhino=args.skip_rhino,
    )

    if args.output_code and result.rhino_code:
        Path(args.output_code).write_text(result.rhino_code)
        print(f"[output] RhinoScript saved to {args.output_code}")

    # Output structured result as JSON for programmatic use
    output = {
        "ok": len(result.errors) == 0,
        "errors": result.errors,
        "image_path": str(result.image_ref.local_path) if result.image_ref else None,
        "analysis": asdict(result.analysis) if result.analysis else None,
        "rhino_code_lines": len(result.rhino_code.splitlines()) if result.rhino_code else 0,
        "rhino_result_ok": result.rhino_result.get("ok") if result.rhino_result else None,
        "comfyui_output": result.comfyui_output,
    }
    print(f"\n{json.dumps(output, indent=2)}")

    return 0 if output["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
