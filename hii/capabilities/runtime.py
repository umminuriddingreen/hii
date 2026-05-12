"""Runtime scanner — OS, Python, package managers, GPU, env names (no values)."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from .schema import (
    DetectionEvidence, PermissionProfile, RuntimeCapability, ScannerReport,
)

SCANNER = "runtime"

# Names we want to surface to agents. Values are never read.
SAFE_ENV_NAMES = {
    "PATH", "HOME", "USERPROFILE", "USERNAME", "USER", "OS",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
    "HII_ROOT", "HII_DIR",
    "COMFYUI_URL", "OLLAMA_URL", "LMSTUDIO_URL",
    "GRASSHOPPER_MCP_HOST", "GRASSHOPPER_MCP_PORT",
    "PYTHONPATH",
}

# Names whose values are sensitive — we report presence only, never the value.
SENSITIVE_ENV_NAMES = {
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "TOGETHER_API_KEY",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "HUGGINGFACE_TOKEN", "HF_TOKEN",
    "GITHUB_TOKEN", "GH_TOKEN", "SERPAPI_API_KEY", "REPLICATE_API_TOKEN",
}


def _which_version(executable: str, args: list[str] | None = None, timeout: float = 3.0) -> tuple[str | None, str | None]:
    """Return (path, version_string) or (None, None). Never raises."""
    path = shutil.which(executable)
    if not path:
        return None, None
    try:
        result = subprocess.run(
            [path] + (args or ["--version"]),
            capture_output=True, text=True, timeout=timeout,
        )
        out = (result.stdout or result.stderr or "").strip().splitlines()
        return path, (out[0] if out else None)
    except Exception:
        return path, None


def _make(id_: str, name: str, available: bool, **kw) -> RuntimeCapability:
    cap = RuntimeCapability(
        id=id_, name=name, available=available,
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )
    for k, v in kw.items():
        setattr(cap, k, v) if hasattr(cap, k) else cap.metadata.update({k: v})
    return cap


def scan() -> tuple[list[RuntimeCapability], ScannerReport]:
    t0 = time.time()
    caps: list[RuntimeCapability] = []
    warnings: list[str] = []
    errors: list[str] = []

    # ── Host identity ─────────────────────────────────────────────
    host = _make(
        "runtime.host", "Host",
        available=True, confidence="high", detection_method="inferred",
        evidence=DetectionEvidence(method="inferred", detail="platform module"),
    )
    host.metadata = {
        "os": platform.system(),
        "os_release": platform.release(),
        "os_version": platform.version(),
        "architecture": platform.machine(),
        "hostname": socket.gethostname(),
        "username": os.environ.get("USERNAME") or os.environ.get("USER") or "",
        "home": str(Path.home()),
        "cwd": str(Path.cwd()),
    }
    host.permission_profile = PermissionProfile(read_only=True, execute_safe=True)
    caps.append(host)

    # ── Shell ──────────────────────────────────────────────────────
    shell_path = os.environ.get("COMSPEC") or os.environ.get("SHELL") or ""
    caps.append(_make(
        "runtime.shell", "Shell",
        available=bool(shell_path), confidence="high" if shell_path else "low",
        detection_method="config", path=shell_path or None,
        evidence=DetectionEvidence(method="config", detail="COMSPEC/SHELL env"),
    ))

    # ── Python ─────────────────────────────────────────────────────
    caps.append(_make(
        "runtime.python", "Python",
        available=True, confidence="high", detection_method="path",
        path=sys.executable, version=platform.python_version(),
        evidence=DetectionEvidence(method="path", detail=sys.executable),
    ))

    # ── pip, git, node, npm, conda ─────────────────────────────────
    for exe, friendly, vargs in [
        ("pip", "pip", ["--version"]),
        ("git", "Git", ["--version"]),
        ("node", "Node.js", ["--version"]),
        ("npm", "npm", ["--version"]),
        ("conda", "Conda", ["--version"]),
        ("uv", "uv", ["--version"]),
        ("pipx", "pipx", ["--version"]),
    ]:
        p, v = _which_version(exe, vargs)
        caps.append(_make(
            f"runtime.{exe}", friendly,
            available=bool(p), confidence="high" if p else "low",
            detection_method="path", path=p, version=v,
            evidence=DetectionEvidence(method="path", detail=p or "not on PATH"),
        ))

    # ── GPU (cheap) ────────────────────────────────────────────────
    nvidia_smi = shutil.which("nvidia-smi")
    gpu_info = None
    if nvidia_smi:
        try:
            result = subprocess.run(
                [nvidia_smi, "--query-gpu=name,memory.total,driver_version",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=4.0,
            )
            line = (result.stdout or "").strip().splitlines()
            gpu_info = [s.strip() for s in line[0].split(",")] if line else None
        except Exception as exc:
            warnings.append(f"nvidia-smi: {exc}")
    cap_gpu = _make(
        "runtime.gpu", "GPU",
        available=bool(gpu_info), confidence="high" if gpu_info else "low",
        detection_method="path" if nvidia_smi else "inferred",
        path=nvidia_smi,
        evidence=DetectionEvidence(method="path", detail=nvidia_smi or "no nvidia-smi"),
    )
    if gpu_info and len(gpu_info) >= 2:
        cap_gpu.metadata = {
            "name": gpu_info[0], "memory_mb": gpu_info[1],
            "driver_version": gpu_info[2] if len(gpu_info) > 2 else "",
        }
    caps.append(cap_gpu)

    # ── Env name surface (NO VALUES) ──────────────────────────────
    present_safe = sorted(n for n in SAFE_ENV_NAMES if n in os.environ)
    present_sensitive = sorted(n for n in SENSITIVE_ENV_NAMES if n in os.environ)
    env_cap = _make(
        "runtime.env", "Environment variables",
        available=True, confidence="high", detection_method="inferred",
        evidence=DetectionEvidence(method="inferred", detail="os.environ key scan"),
    )
    env_cap.metadata = {
        "safe_names_present": present_safe,
        "sensitive_names_present": present_sensitive,
        "values_redacted": True,
        "redaction_marker": "[REDACTED]",
    }
    env_cap.permission_profile = PermissionProfile(
        read_only=True, touches_credentials=bool(present_sensitive),
        notes="env names only; values never read",
    )
    caps.append(env_cap)

    duration_ms = (time.time() - t0) * 1000
    detected = sum(1 for c in caps if c.available)
    avg_conf = _avg_confidence(caps)
    report = ScannerReport(
        scanner=SCANNER, status="success",
        detected_count=detected, confidence_average=avg_conf,
        false_positive_risk="low", false_negative_risk="low",
        duration_ms=duration_ms, warnings=warnings, errors=errors,
    )
    return caps, report


def _avg_confidence(caps: list) -> float:
    if not caps:
        return 0.0
    score = {"high": 1.0, "medium": 0.6, "low": 0.2}
    return round(sum(score.get(c.confidence, 0.0) for c in caps) / len(caps), 2)
