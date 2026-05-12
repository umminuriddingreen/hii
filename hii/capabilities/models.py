"""Service + model scanner — ComfyUI, Ollama, LM Studio (offline is OK).

Detects services AND, when reachable, enumerates models hosted by each.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from .schema import (
    DetectionEvidence, ModelCapability, PermissionProfile, ScannerReport,
    ServiceCapability,
)

SCANNER = "services_models"

DEFAULTS = {
    "comfyui":  os.environ.get("COMFYUI_URL",  "http://127.0.0.1:8188"),
    "ollama":   os.environ.get("OLLAMA_URL",   "http://127.0.0.1:11434"),
    "lmstudio": os.environ.get("LMSTUDIO_URL", "http://127.0.0.1:1234/v1"),
    "grasshopper_mcp": (
        f"tcp://{os.environ.get('GRASSHOPPER_MCP_HOST','127.0.0.1')}"
        f":{os.environ.get('GRASSHOPPER_MCP_PORT','8080')}"
    ),
}

CONNECT_TIMEOUT = 1.5
READ_TIMEOUT = 4.0


def _fetch_json(url: str) -> tuple[bool, dict | list | None, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "HII/0.4.0 capability-scanner"})
    try:
        with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as resp:
            data = json.loads(resp.read())
            return True, data, ""
    except urllib.error.URLError as exc:
        return False, None, f"unreachable: {exc.reason}"
    except Exception as exc:
        return False, None, f"error: {exc}"


def _make_service(id_: str, name: str, endpoint: str, **kw) -> ServiceCapability:
    cap = ServiceCapability(
        id=f"service.{id_}", name=name, endpoint=endpoint,
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
        permission_profile=PermissionProfile(read_only=True, execute_safe=True,
                                             requires_network=False,
                                             notes="localhost HTTP probe"),
    )
    for k, v in kw.items():
        if hasattr(cap, k):
            setattr(cap, k, v)
        else:
            cap.metadata[k] = v
    return cap


def _make_model(id_: str, name: str, provider: str, model_type: str, **kw) -> ModelCapability:
    cap = ModelCapability(
        id=f"model.{provider}.{id_}", name=name,
        provider=provider, model_type=model_type,
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
        available=True, confidence="high", detection_method="localhost",
        evidence=DetectionEvidence(method="localhost", detail=provider),
        permission_profile=PermissionProfile(read_only=True, execute_safe=True),
    )
    for k, v in kw.items():
        if hasattr(cap, k):
            setattr(cap, k, v)
        else:
            cap.metadata[k] = v
    return cap


# ── ComfyUI ────────────────────────────────────────────────────────────────

COMFY_TYPE_KEYS = {
    "ckpt_name":          "checkpoint",
    "unet_name":          "diffusion_model",
    "vae_name":           "vae",
    "lora_name":          "lora",
    "control_net_name":   "controlnet",
    "model_name":         "upscaler",
}


def _scan_comfyui(endpoint: str) -> tuple[ServiceCapability, list[ModelCapability]]:
    svc = _make_service(
        "comfyui", "ComfyUI", endpoint,
        available=False, confidence="high", detection_method="localhost",
        evidence=DetectionEvidence(method="localhost", detail=endpoint),
    )
    ok, data, err = _fetch_json(f"{endpoint}/object_info")
    models: list[ModelCapability] = []
    if not ok or not isinstance(data, dict):
        svc.warnings.append(err or "no /object_info")
        svc.metadata["status"] = "offline"
        return svc, models

    svc.available = True
    svc.metadata["status"] = "online"

    seen: dict[str, set[str]] = {}
    for node_name, node_info in data.items():
        try:
            required = (node_info.get("input") or {}).get("required") or {}
            for key, spec in required.items():
                if key not in COMFY_TYPE_KEYS:
                    continue
                mtype = COMFY_TYPE_KEYS[key]
                # spec is typically [list-of-names, ...]; first element holds names
                names = spec[0] if isinstance(spec, list) and spec else None
                if not isinstance(names, list):
                    continue
                seen.setdefault(mtype, set()).update(str(n) for n in names)
        except Exception:
            continue

    for mtype, names in seen.items():
        for name in sorted(names):
            models.append(_make_model(
                id_=f"{mtype}.{name}", name=name, provider="comfyui", model_type=mtype,
                metadata={"comfyui_node_input_key": next(
                    (k for k, v in COMFY_TYPE_KEYS.items() if v == mtype), ""
                )},
            ))

    svc.metadata["model_counts"] = {k: len(v) for k, v in seen.items()}
    return svc, models


# ── Ollama ─────────────────────────────────────────────────────────────────

def _scan_ollama(endpoint: str) -> tuple[ServiceCapability, list[ModelCapability]]:
    svc = _make_service(
        "ollama", "Ollama", endpoint,
        available=False, confidence="high", detection_method="localhost",
        evidence=DetectionEvidence(method="localhost", detail=endpoint),
    )
    ok, data, err = _fetch_json(f"{endpoint}/api/tags")
    models: list[ModelCapability] = []
    if not ok or not isinstance(data, dict):
        svc.warnings.append(err or "no /api/tags")
        svc.metadata["status"] = "offline"
        return svc, models

    svc.available = True
    svc.metadata["status"] = "online"

    for m in data.get("models", []) or []:
        try:
            name = m.get("name") or m.get("model") or ""
            if not name:
                continue
            models.append(_make_model(
                id_=name, name=name, provider="ollama", model_type="llm",
                metadata={
                    "size_bytes": m.get("size"),
                    "digest": m.get("digest"),
                    "modified_at": m.get("modified_at"),
                    "details": m.get("details") or {},
                },
            ))
        except Exception:
            continue
    svc.metadata["model_count"] = len(models)
    return svc, models


# ── LM Studio ──────────────────────────────────────────────────────────────

def _scan_lmstudio(endpoint: str) -> tuple[ServiceCapability, list[ModelCapability]]:
    svc = _make_service(
        "lmstudio", "LM Studio", endpoint,
        available=False, confidence="high", detection_method="localhost",
        evidence=DetectionEvidence(method="localhost", detail=endpoint),
    )
    ok, data, err = _fetch_json(f"{endpoint}/models")
    models: list[ModelCapability] = []
    if not ok or not isinstance(data, dict):
        svc.warnings.append(err or "no /models")
        svc.metadata["status"] = "offline"
        return svc, models

    svc.available = True
    svc.metadata["status"] = "online"

    for m in data.get("data", []) or []:
        try:
            name = m.get("id") or m.get("name") or ""
            if not name:
                continue
            models.append(_make_model(
                id_=name, name=name, provider="lmstudio", model_type="llm",
                metadata={"owned_by": m.get("owned_by")},
            ))
        except Exception:
            continue
    svc.metadata["model_count"] = len(models)
    return svc, models


# ── Grasshopper MCP (TCP probe, not HTTP) ──────────────────────────────────

def _scan_grasshopper(endpoint: str) -> ServiceCapability:
    import socket
    svc = _make_service(
        "grasshopper_mcp", "Grasshopper MCP bridge", endpoint,
        available=False, confidence="medium", detection_method="localhost",
        evidence=DetectionEvidence(method="localhost", detail=endpoint),
    )
    # endpoint shape: tcp://host:port
    try:
        host_port = endpoint.split("://", 1)[1]
        host, port = host_port.split(":")
        with socket.create_connection((host, int(port)), timeout=CONNECT_TIMEOUT):
            svc.available = True
            svc.metadata["status"] = "online"
    except Exception as exc:
        svc.warnings.append(f"socket: {exc}")
        svc.metadata["status"] = "offline"
    return svc


# ── Entry point ────────────────────────────────────────────────────────────

def scan() -> tuple[list[ServiceCapability], list[ModelCapability], ScannerReport]:
    t0 = time.time()
    services: list[ServiceCapability] = []
    models: list[ModelCapability] = []
    warnings: list[str] = []
    errors: list[str] = []
    partial = False

    for scanner_name, fn in [
        ("comfyui", _scan_comfyui),
        ("ollama", _scan_ollama),
        ("lmstudio", _scan_lmstudio),
    ]:
        try:
            svc, mdls = fn(DEFAULTS[scanner_name])
            services.append(svc)
            models.extend(mdls)
            if not svc.available:
                partial = True
        except Exception as exc:
            errors.append(f"{scanner_name}: {exc}")
            partial = True

    try:
        services.append(_scan_grasshopper(DEFAULTS["grasshopper_mcp"]))
    except Exception as exc:
        errors.append(f"grasshopper_mcp: {exc}")
        partial = True

    duration_ms = (time.time() - t0) * 1000
    detected = sum(1 for s in services if s.available) + len(models)
    report = ScannerReport(
        scanner=SCANNER,
        status="partial" if (partial and detected > 0) else ("success" if detected > 0 else ("failed" if errors else "partial")),
        detected_count=detected,
        confidence_average=1.0 if all(s.available for s in services) else 0.6,
        false_positive_risk="low",
        false_negative_risk="low",
        duration_ms=duration_ms, warnings=warnings, errors=errors,
    )
    return services, models, report
