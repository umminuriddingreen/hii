#!/usr/bin/env python3
"""
Send a 2D image to ComfyUI for image-to-3D generation.
Supports workflows using Wan 2.1 / TripoSR / other image-to-3D nodes.

Usage:
    python comfyui_generate.py <input_image> [--output-dir <dir>] [--workflow <path>]
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import uuid
import base64
from pathlib import Path

COMFYUI_URL = "http://127.0.0.1:8188"


def upload_image(image_path: str, subfolder: str = "input") -> str:
    """Upload an image to ComfyUI's input directory."""
    filename = os.path.basename(image_path)
    with open(image_path, "rb") as f:
        image_data = f.read()

    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode() + image_data + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{COMFYUI_URL}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        print(f"  Uploaded: {result.get('name', filename)}")
        return result.get("name", filename)
    except Exception as e:
        print(f"  Upload failed: {e}")
        print(f"  Falling back to manual copy...")
        return filename


def get_default_workflow():
    """Return a basic image-to-3D workflow template for ComfyUI.

    This is a generic template. Users should replace with their actual
    workflow JSON exported from ComfyUI that includes their preferred
    image-to-3D nodes (Wan 2.1, TripoSR, etc.).
    """
    return {
        "_comment": "REPLACE THIS with your actual ComfyUI workflow JSON",
        "_instructions": [
            "1. Open ComfyUI in browser (http://127.0.0.1:8188)",
            "2. Set up your image-to-3D workflow (Wan 2.1, TripoSR, etc.)",
            "3. Click 'Save (API Format)' to export the workflow JSON",
            "4. Save it as workflows/image_to_3d.json in this project",
            "5. Run: python comfyui_generate.py <image> --workflow workflows/image_to_3d.json",
        ],
        "1": {
            "class_type": "LoadImage",
            "inputs": {
                "image": "INPUT_IMAGE_PLACEHOLDER"
            }
        },
        "2": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "output_3d",
                "images": ["1", 0]
            }
        }
    }


def queue_prompt(workflow: dict, client_id: str) -> str:
    """Queue a prompt/workflow in ComfyUI and return the prompt_id."""
    payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()
    req = urllib.request.Request(
        f"{COMFYUI_URL}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())
    return result["prompt_id"]


def poll_for_completion(prompt_id: str, timeout: int = 600) -> dict:
    """Poll ComfyUI until the prompt completes or times out."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = urllib.request.urlopen(f"{COMFYUI_URL}/history/{prompt_id}")
            history = json.loads(resp.read())
            if prompt_id in history:
                return history[prompt_id]
        except Exception:
            pass
        time.sleep(2)
        elapsed = int(time.time() - start)
        if elapsed % 10 == 0:
            print(f"  Waiting... ({elapsed}s)")
    raise TimeoutError(f"ComfyUI prompt did not complete within {timeout}s")


def download_outputs(history: dict, output_dir: str) -> list:
    """Download output files (images, 3D models) from completed prompt."""
    outputs = []
    os.makedirs(output_dir, exist_ok=True)

    for node_id, node_output in history.get("outputs", {}).items():
        # Handle image outputs
        for img in node_output.get("images", []):
            filename = img["filename"]
            subfolder = img.get("subfolder", "")
            url = f"{COMFYUI_URL}/view?filename={urllib.parse.quote(filename)}&subfolder={urllib.parse.quote(subfolder)}&type=output"
            out_path = os.path.join(output_dir, filename)
            urllib.request.urlretrieve(url, out_path)
            outputs.append(out_path)
            print(f"  Downloaded: {out_path}")

        # Handle 3D model outputs (gltf, obj, etc.)
        for model_file in node_output.get("gltf", node_output.get("mesh", node_output.get("3d", []))):
            if isinstance(model_file, dict):
                filename = model_file.get("filename", "output.glb")
                subfolder = model_file.get("subfolder", "")
            else:
                filename = str(model_file)
                subfolder = ""
            url = f"{COMFYUI_URL}/view?filename={urllib.parse.quote(filename)}&subfolder={urllib.parse.quote(subfolder)}&type=output"
            out_path = os.path.join(output_dir, filename)
            try:
                urllib.request.urlretrieve(url, out_path)
                outputs.append(out_path)
                print(f"  Downloaded 3D: {out_path}")
            except Exception as e:
                print(f"  Could not download {filename}: {e}")

    return outputs


def check_comfyui():
    """Check if ComfyUI is reachable."""
    try:
        resp = urllib.request.urlopen(f"{COMFYUI_URL}/system_stats", timeout=5)
        stats = json.loads(resp.read())
        print(f"  ComfyUI is running")
        if "system" in stats:
            gpu = stats["system"].get("devices", [{}])
            if gpu:
                print(f"  GPU: {gpu[0].get('name', 'unknown')}")
        return True
    except Exception as e:
        print(f"  ComfyUI not reachable at {COMFYUI_URL}: {e}")
        return False


def run(image_path: str, output_dir: str, workflow_path: str = None):
    """Full pipeline: upload image, run workflow, download results."""
    print(f"\n=== ComfyUI Image-to-3D Generation ===")
    print(f"Input: {image_path}")

    # Check ComfyUI
    if not check_comfyui():
        print("\nComfyUI is not running. Please start it:")
        print("  cd /path/to/ComfyUI && python main.py")
        print("\nAlternative: Use the web-based tools instead:")
        print("  - TripoSR: Upload image at https://huggingface.co/spaces/stabilityai/TripoSR")
        print("  - Meshy.ai: Upload at meshy.ai")
        print("  - Save the output OBJ/GLB to:", output_dir)
        return []

    # Upload image
    print("\n1. Uploading image...")
    uploaded_name = upload_image(image_path)

    # Load or create workflow
    print("\n2. Loading workflow...")
    if workflow_path and os.path.exists(workflow_path):
        with open(workflow_path) as f:
            workflow = json.load(f)
        print(f"  Using workflow: {workflow_path}")
    else:
        workflow = get_default_workflow()
        # Save template for user to customize
        template_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "workflows")
        os.makedirs(template_dir, exist_ok=True)
        template_path = os.path.join(template_dir, "image_to_3d_TEMPLATE.json")
        if not os.path.exists(template_path):
            with open(template_path, "w") as f:
                json.dump(workflow, f, indent=2)
            print(f"  Saved workflow template: {template_path}")
            print(f"  ** Replace this with your actual ComfyUI workflow! **")
        return []

    # Inject input image into workflow
    for node_id, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == "LoadImage":
            node["inputs"]["image"] = uploaded_name
            print(f"  Injected image into node {node_id}")

    # Queue and run
    print("\n3. Queuing workflow...")
    client_id = str(uuid.uuid4())
    prompt_id = queue_prompt(workflow, client_id)
    print(f"  Prompt ID: {prompt_id}")

    print("\n4. Waiting for completion...")
    history = poll_for_completion(prompt_id)
    print("  Done!")

    # Download outputs
    print("\n5. Downloading outputs...")
    outputs = download_outputs(history, output_dir)

    print(f"\n=== Complete! {len(outputs)} file(s) saved to {output_dir} ===")
    return outputs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send image to ComfyUI for 3D generation")
    parser.add_argument("input", help="Path to input 2D image")
    parser.add_argument("--output-dir", "-o", default=None, help="Output directory")
    parser.add_argument("--workflow", "-w", default=None, help="ComfyUI workflow JSON")
    args = parser.parse_args()

    if args.output_dir is None:
        # Auto-detect chain directory
        input_path = Path(args.input).resolve()
        if "chains" in str(input_path) and "inputs" in str(input_path):
            args.output_dir = str(input_path.parent.parent / "ai_output")
        else:
            args.output_dir = str(input_path.parent / "ai_output")

    run(args.input, args.output_dir, args.workflow)
