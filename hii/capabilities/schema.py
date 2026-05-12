"""Capability schemas — all dataclasses are JSON-serializable via asdict()."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal


Confidence = Literal["high", "medium", "low"]
DetectionMethod = Literal[
    "path", "process", "localhost", "config", "inferred",
    "filesystem", "registry", "unknown",
]
ScannerStatus = Literal["success", "partial", "failed", "skipped"]


@dataclass
class DetectionEvidence:
    """How a capability was detected. Useful for debugging false positives."""
    method: DetectionMethod = "unknown"
    detail: str = ""
    matched_at: str = ""  # path, URL, command, etc.


@dataclass
class PermissionProfile:
    """Conservative defaults: read_only unless explicitly safe to execute."""
    read_only: bool = True
    execute_safe: bool = False
    execute_confirm: bool = False
    destructive_confirm: bool = False
    blocked: bool = False
    requires_network: bool = False
    touches_credentials: bool = False
    touches_user_files: bool = False
    touches_system_settings: bool = False
    notes: str = ""


# ── Base capability ─────────────────────────────────────────────────────────

@dataclass
class _BaseCapability:
    id: str
    name: str
    kind: str  # "runtime" | "app" | "service" | "model" | "workflow" | "asset"
    available: bool = False
    confidence: Confidence = "low"
    detection_method: DetectionMethod = "unknown"
    source_scanner: str = ""
    path: str | None = None
    endpoint: str | None = None
    version: str | None = None
    last_checked: str = ""
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    permission_profile: PermissionProfile = field(default_factory=PermissionProfile)
    evidence: DetectionEvidence = field(default_factory=DetectionEvidence)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RuntimeCapability(_BaseCapability):
    kind: str = "runtime"


@dataclass
class AppCapability(_BaseCapability):
    kind: str = "app"


@dataclass
class ServiceCapability(_BaseCapability):
    """Local HTTP/process service (ComfyUI, Ollama, LM Studio, MCP bridges)."""
    kind: str = "service"


@dataclass
class ModelCapability(_BaseCapability):
    """Image checkpoint, LLM weight, LoRA, VAE, ControlNet, upscaler, 3D model, …"""
    kind: str = "model"
    model_type: str = "unknown"   # checkpoint | lora | vae | controlnet | upscaler | llm | embed | ...
    provider: str = ""            # "comfyui" | "ollama" | "lmstudio" | ...


@dataclass
class WorkflowCapability(_BaseCapability):
    """A reusable file an agent can load/execute: .json (ComfyUI), .gh/.ghx, .py, .bat, .ps1, .yaml, .md."""
    kind: str = "workflow"
    file_extension: str = ""
    size_bytes: int = 0


@dataclass
class AssetCapability(_BaseCapability):
    """A passive output/artifact (image, render, 3D file, log, json)."""
    kind: str = "asset"
    media_type: str = "unknown"   # image | video | 3d | text | log | json | unknown
    size_bytes: int = 0
    modified_at: str = ""
    content_hash: str | None = None
    likely_source_skill: str | None = None


# ── Scanner self-evaluation ────────────────────────────────────────────────

@dataclass
class ScannerReport:
    scanner: str
    status: ScannerStatus = "skipped"
    detected_count: int = 0
    confidence_average: float = 0.0
    false_positive_risk: str = "low"   # low | medium | high
    false_negative_risk: str = "low"
    duration_ms: float = 0.0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# ── Top-level map ──────────────────────────────────────────────────────────

@dataclass
class CapabilityMap:
    version: str = "0.4.0"
    scan_id: str = ""
    generated_at: str = ""
    host: dict[str, Any] = field(default_factory=dict)  # short summary so consumers see core ids fast
    runtime: list[RuntimeCapability] = field(default_factory=list)
    apps: list[AppCapability] = field(default_factory=list)
    services: list[ServiceCapability] = field(default_factory=list)
    models: list[ModelCapability] = field(default_factory=list)
    workflows: list[WorkflowCapability] = field(default_factory=list)
    assets: list[AssetCapability] = field(default_factory=list)
    allowed_roots: list[str] = field(default_factory=list)
    scanner_reports: list[ScannerReport] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def counts(self) -> dict[str, int]:
        return {
            "runtime": len(self.runtime),
            "apps": len(self.apps),
            "services": len(self.services),
            "models": len(self.models),
            "workflows": len(self.workflows),
            "assets": len(self.assets),
        }
