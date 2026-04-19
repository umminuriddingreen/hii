from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


DEFAULT_COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")


class ComfyUiError(RuntimeError):
    pass


@dataclass
class ComfyPlan:
    prompt: str
    negative_prompt: str
    model: str | None
    width: int
    height: int
    steps: int
    cfg: float
    seed: int
    batch_size: int
    output_prefix: str


def _json_get(url: str, timeout: float = 10.0) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.URLError as exc:
        raise ComfyUiError(f"ComfyUI request failed: {exc}") from exc


def _json_post(url: str, payload: dict[str, Any], timeout: float = 15.0) -> Any:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.URLError as exc:
        raise ComfyUiError(f"ComfyUI request failed: {exc}") from exc


def slugify(text: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    parts = [part for part in cleaned.split("-") if part]
    return "-".join(parts)[:48] or "comfy-job"


def pick_model(comfyui_url: str, explicit_model: str | None = None) -> str:
    info = _json_get(f"{comfyui_url}/object_info")
    models = info.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {}).get("ckpt_name", [[]])[0]
    if not models:
        raise ComfyUiError("No checkpoint models were reported by ComfyUI.")
    if not explicit_model:
        return models[0]
    for model in models:
        if model == explicit_model:
            return model
    for model in models:
        if explicit_model.lower() in model.lower():
            return model
    raise ComfyUiError(f"Model not found in ComfyUI: {explicit_model}")


def plan_text_to_image(
    prompt: str,
    negative_prompt: str | None = None,
    model: str | None = None,
    width: int = 1024,
    height: int = 1024,
    steps: int = 30,
    cfg: float = 7.0,
    seed: int | None = None,
    batch_size: int = 1,
    output_prefix: str | None = None,
) -> ComfyPlan:
    return ComfyPlan(
        prompt=prompt.strip(),
        negative_prompt=(negative_prompt or "blurry, low quality, artifacts, deformed, watermark").strip(),
        model=model,
        width=max(512, min(2048, int(round(width / 64) * 64))),
        height=max(512, min(2048, int(round(height / 64) * 64))),
        steps=max(8, min(80, int(steps))),
        cfg=max(1.0, min(16.0, float(cfg))),
        seed=seed if seed is not None else int(uuid.uuid4().int % 2_147_483_647),
        batch_size=max(1, min(8, int(batch_size))),
        output_prefix=output_prefix or f"hii-{slugify(prompt)}",
    )


def build_text_to_image_workflow(plan: ComfyPlan, resolved_model: str) -> dict[str, Any]:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": plan.seed,
                "steps": plan.steps,
                "cfg": plan.cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": resolved_model}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": plan.width, "height": plan.height, "batch_size": plan.batch_size}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": plan.prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": plan.negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": plan.output_prefix, "images": ["8", 0]}},
    }


def queue_workflow(comfyui_url: str, workflow: dict[str, Any], client_id: str | None = None) -> dict[str, Any]:
    client_id = client_id or str(uuid.uuid4())
    response = _json_post(f"{comfyui_url}/prompt", {"client_id": client_id, "prompt": workflow})
    if not response.get("prompt_id"):
        raise ComfyUiError(f"ComfyUI did not return a prompt id: {response}")
    return {"client_id": client_id, "prompt_id": response["prompt_id"], "response": response}


def wait_for_outputs(comfyui_url: str, prompt_id: str, timeout_s: int = 180) -> list[dict[str, str]]:
    started = time.time()
    while time.time() - started < timeout_s:
        history = _json_get(f"{comfyui_url}/history/{prompt_id}")
        run = history.get(prompt_id)
        outputs = []
        if run:
            for node_output in run.get("outputs", {}).values():
                for image in node_output.get("images", []):
                    filename = image.get("filename")
                    subfolder = image.get("subfolder", "")
                    file_type = image.get("type", "output")
                    if not filename:
                        continue
                    query = urllib.parse.urlencode(
                        {"filename": filename, "subfolder": subfolder, "type": file_type}
                    )
                    outputs.append(
                        {
                            "filename": filename,
                            "subfolder": subfolder,
                            "type": file_type,
                            "url": f"{comfyui_url}/view?{query}",
                        }
                    )
        if outputs:
            return outputs
        time.sleep(1.5)
    raise ComfyUiError(f"Timed out waiting for ComfyUI outputs for prompt {prompt_id}.")


def run_text_to_image(
    prompt: str,
    comfyui_url: str = DEFAULT_COMFYUI_URL,
    *,
    negative_prompt: str | None = None,
    model: str | None = None,
    width: int = 1024,
    height: int = 1024,
    steps: int = 30,
    cfg: float = 7.0,
    seed: int | None = None,
    batch_size: int = 1,
    output_prefix: str | None = None,
    wait: bool = True,
) -> dict[str, Any]:
    plan = plan_text_to_image(
        prompt=prompt,
        negative_prompt=negative_prompt,
        model=model,
        width=width,
        height=height,
        steps=steps,
        cfg=cfg,
        seed=seed,
        batch_size=batch_size,
        output_prefix=output_prefix,
    )
    resolved_model = pick_model(comfyui_url, plan.model)
    workflow = build_text_to_image_workflow(plan, resolved_model)
    queued = queue_workflow(comfyui_url, workflow)
    result = {
        "ok": True,
        "comfyui_url": comfyui_url,
        "prompt_id": queued["prompt_id"],
        "client_id": queued["client_id"],
        "plan": asdict(plan) | {"model": resolved_model},
    }
    if wait:
        result["outputs"] = wait_for_outputs(comfyui_url, queued["prompt_id"])
    return result


def load_workflow(path: str | Path) -> dict[str, Any]:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def inject_image_name(workflow: dict[str, Any], image_name: str) -> dict[str, Any]:
    mutated = json.loads(json.dumps(workflow))
    for node in mutated.values():
        if isinstance(node, dict) and node.get("class_type") == "LoadImage":
            inputs = node.setdefault("inputs", {})
            inputs["image"] = image_name
    return mutated


def status(comfyui_url: str = DEFAULT_COMFYUI_URL) -> dict[str, Any]:
    try:
        stats = _json_get(f"{comfyui_url}/system_stats", timeout=5.0)
        return {"reachable": True, "comfyui_url": comfyui_url, "stats": stats}
    except ComfyUiError as exc:
        return {"reachable": False, "comfyui_url": comfyui_url, "error": str(exc)}
