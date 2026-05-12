"""HII capabilities — the sensory layer.

Public API (use these from skills and agents):

    get_capability_map()          → CapabilityMap   (cached if fresh, else refresh)
    refresh_capability_map()      → CapabilityMap   (force rescan)
    export_for_llm()              → str             (markdown agent context)
    export_as_json()              → str             (raw JSON)

All scanners are fail-soft: partial failures surface as warnings/errors on the
returned map, never as raised exceptions from this module.
"""

from __future__ import annotations

from typing import Any

from . import cache, export  # detector imported lazily to avoid `python -m hii.capabilities.detector` re-import warning
from .schema import (
    AppCapability, AssetCapability, CapabilityMap, DetectionEvidence,
    ModelCapability, PermissionProfile, RuntimeCapability, ScannerReport,
    ServiceCapability, WorkflowCapability,
)

__all__ = [
    "get_capability_map", "refresh_capability_map",
    "export_for_llm", "export_as_json",
    "CapabilityMap", "RuntimeCapability", "AppCapability", "ServiceCapability",
    "ModelCapability", "WorkflowCapability", "AssetCapability",
    "PermissionProfile", "ScannerReport", "DetectionEvidence",
]


def get_capability_map(*, ttl_seconds: int = 3600) -> CapabilityMap:
    """Return cached map if it's within TTL; otherwise force a fresh scan."""
    if cache.is_fresh(ttl_seconds):
        data = cache.read_current()
        if data is not None:
            return _from_dict(data)
    return refresh_capability_map()


def refresh_capability_map() -> CapabilityMap:
    from . import detector  # lazy import
    return detector.run()


def export_for_llm() -> str:
    return export.as_llm(get_capability_map())


def export_as_json() -> str:
    return export.as_json(get_capability_map())


# ── Internal: round-trip cache dict back to CapabilityMap dataclass ────────

def _from_dict(data: dict[str, Any]) -> CapabilityMap:
    """Best-effort rehydration of a CapabilityMap from its JSON form.

    We intentionally keep this loose: missing/extra fields are tolerated so
    that older cached maps don't break callers after a schema bump.
    """
    cap = CapabilityMap()
    cap.version = data.get("version", cap.version)
    cap.scan_id = data.get("scan_id", "")
    cap.generated_at = data.get("generated_at", "")
    cap.host = data.get("host") or {}
    cap.allowed_roots = list(data.get("allowed_roots") or [])
    cap.warnings = list(data.get("warnings") or [])
    cap.errors = list(data.get("errors") or [])
    cap.runtime  = _rehydrate(data.get("runtime"),  RuntimeCapability)
    cap.apps     = _rehydrate(data.get("apps"),     AppCapability)
    cap.services = _rehydrate(data.get("services"), ServiceCapability)
    cap.models   = _rehydrate(data.get("models"),   ModelCapability)
    cap.workflows= _rehydrate(data.get("workflows"),WorkflowCapability)
    cap.assets   = _rehydrate(data.get("assets"),   AssetCapability)
    cap.scanner_reports = _rehydrate(data.get("scanner_reports"), ScannerReport)
    return cap


def _rehydrate(items: list[dict] | None, cls):
    if not items:
        return []
    out = []
    for raw in items:
        try:
            # Filter to known fields so unknown future fields don't crash __init__
            known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
            kwargs = {k: v for k, v in raw.items() if k in known}
            # PermissionProfile + DetectionEvidence are nested dicts
            if "permission_profile" in kwargs and isinstance(kwargs["permission_profile"], dict):
                kwargs["permission_profile"] = PermissionProfile(**{
                    k: v for k, v in kwargs["permission_profile"].items()
                    if k in PermissionProfile.__dataclass_fields__
                })
            if "evidence" in kwargs and isinstance(kwargs["evidence"], dict):
                kwargs["evidence"] = DetectionEvidence(**{
                    k: v for k, v in kwargs["evidence"].items()
                    if k in DetectionEvidence.__dataclass_fields__
                })
            out.append(cls(**kwargs))
        except Exception:
            continue
    return out
