"""Workflow scanner — index reusable workflow files inside allowed roots only.

Detects: .json (ComfyUI/MCP), .py, .gh, .ghx, .bat, .ps1, .yaml, .yml, .md.
"""

from __future__ import annotations

import time
from pathlib import Path

from .schema import (
    DetectionEvidence, PermissionProfile, ScannerReport, WorkflowCapability,
)

SCANNER = "workflows"

WORKFLOW_EXTS = {".json", ".py", ".gh", ".ghx", ".bat", ".ps1", ".yaml", ".yml", ".md"}

# Folders never to descend into
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".pytest_cache", ".mypy_cache", "dist", "build", ".cache",
    ".idea", ".vscode", "site-packages",
}

MAX_FILES_DEFAULT = 500
MAX_DEPTH_DEFAULT = 6


def _walk(root: Path, max_files: int, max_depth: int) -> list[Path]:
    found: list[Path] = []
    root = root.resolve()
    if not root.exists() or not root.is_dir():
        return found
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack and len(found) < max_files:
        cur, depth = stack.pop()
        if depth > max_depth:
            continue
        try:
            for entry in cur.iterdir():
                if entry.name in SKIP_DIRS:
                    continue
                try:
                    if entry.is_dir():
                        stack.append((entry, depth + 1))
                    elif entry.suffix.lower() in WORKFLOW_EXTS:
                        found.append(entry)
                        if len(found) >= max_files:
                            break
                except OSError:
                    continue
        except (PermissionError, OSError):
            continue
    return found


def _classify(path: Path) -> tuple[str, PermissionProfile]:
    """Return (label, permission_profile) for a workflow file."""
    ext = path.suffix.lower()
    if ext == ".json":
        return "data/workflow", PermissionProfile(read_only=True, execute_safe=True,
                                                  notes="JSON — typically loaded, not executed directly")
    if ext == ".md":
        return "prompt/notes", PermissionProfile(read_only=True, execute_safe=True,
                                                 notes="prompt or notes file")
    if ext in (".yaml", ".yml"):
        return "config", PermissionProfile(read_only=True, execute_safe=True,
                                           notes="config / declarative workflow")
    if ext == ".py":
        return "python_script", PermissionProfile(read_only=False, execute_confirm=True,
                                                  notes="Python script — confirm before running")
    if ext in (".bat", ".ps1"):
        return "shell_script", PermissionProfile(read_only=False, execute_confirm=True,
                                                 destructive_confirm=True,
                                                 notes="shell script — destructive_confirm by default")
    if ext in (".gh", ".ghx"):
        return "grasshopper_def", PermissionProfile(read_only=False, execute_confirm=True,
                                                    notes="Grasshopper definition — load into Rhino")
    return "unknown", PermissionProfile(read_only=True)


def _make(root_label: str, path: Path) -> WorkflowCapability:
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    label, perm = _classify(path)
    return WorkflowCapability(
        id=f"workflow.{root_label}.{path.name}",
        name=path.name,
        available=True, confidence="high", detection_method="filesystem",
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
        path=str(path), file_extension=path.suffix.lower(), size_bytes=size,
        permission_profile=perm,
        evidence=DetectionEvidence(method="filesystem", detail=str(path)),
        metadata={"root": root_label, "classification": label},
    )


def scan(
    roots: list[Path] | None = None,
    max_files_per_root: int = MAX_FILES_DEFAULT,
    max_depth: int = MAX_DEPTH_DEFAULT,
) -> tuple[list[WorkflowCapability], ScannerReport]:
    t0 = time.time()
    caps: list[WorkflowCapability] = []
    warnings: list[str] = []
    truncated_roots: list[str] = []

    if roots is None:
        roots = default_roots()

    for root in roots:
        label = root.name or str(root)
        found = _walk(root, max_files_per_root, max_depth)
        if len(found) >= max_files_per_root:
            truncated_roots.append(str(root))
            warnings.append(f"truncated at {max_files_per_root} files in {root}")
        for p in found:
            try:
                caps.append(_make(label, p))
            except Exception as exc:
                warnings.append(f"{p}: {exc}")

    duration_ms = (time.time() - t0) * 1000
    report = ScannerReport(
        scanner=SCANNER, status="success" if caps else "partial",
        detected_count=len(caps),
        confidence_average=1.0 if caps else 0.0,
        false_positive_risk="medium",  # we match by extension only
        false_negative_risk="medium" if truncated_roots else "low",
        duration_ms=duration_ms, warnings=warnings,
    )
    return caps, report


def default_roots() -> list[Path]:
    """Safe defaults — limited to known HII territory + cwd."""
    roots = [
        Path.home() / ".hii" / "workflows",
        Path.home() / ".hii" / "skills",
        Path.cwd(),
    ]
    # Common adjacent projects on this dev box
    extras = [
        Path.home() / "Desktop" / "comfyui-building-design",
        Path.home() / "Desktop" / "hii-test" / "agent-harness",
    ]
    for e in extras:
        if e.exists():
            roots.append(e)
    return [r for r in roots if r.exists()]
