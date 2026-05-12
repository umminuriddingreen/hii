"""App scanner — detect installed creative/dev apps via PATH + common install dirs.

Safe: PATH lookup, glob of known install roots, no full-drive scans.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from .schema import (
    AppCapability, DetectionEvidence, PermissionProfile, ScannerReport,
)

SCANNER = "apps"

PROGRAM_FILES = [
    os.environ.get("ProgramFiles", r"C:\Program Files"),
    os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")) + r"\Programs",
]

# Each entry: id, friendly name, executable basename (PATH), [glob patterns from program files]
APP_TARGETS = [
    ("rhino", "Rhino", "Rhino.exe", ["Rhino*/System/Rhino.exe", "Rhino*/Rhino*.exe"]),
    ("blender", "Blender", "blender.exe", ["Blender Foundation/Blender*/blender.exe"]),
    ("revit", "Revit", "Revit.exe", ["Autodesk/Revit*/Revit.exe"]),
    ("autocad", "AutoCAD", "acad.exe", ["Autodesk/AutoCAD*/acad.exe"]),
    ("sketchup", "SketchUp", "SketchUp.exe", ["SketchUp/SketchUp*/SketchUp.exe"]),
    ("twinmotion", "Twinmotion", "Twinmotion.exe", ["Epic Games/Twinmotion*/Twinmotion.exe"]),
    ("vscode", "VS Code", "code.cmd", ["Microsoft VS Code/Code.exe"]),
    ("chrome", "Chrome", "chrome.exe", ["Google/Chrome/Application/chrome.exe"]),
    ("edge", "Edge", "msedge.exe", ["Microsoft/Edge/Application/msedge.exe"]),
    ("firefox", "Firefox", "firefox.exe", ["Mozilla Firefox/firefox.exe"]),
    ("notepad", "Notepad", "notepad.exe", []),
    ("powershell", "PowerShell", "powershell.exe", []),
    ("pwsh", "PowerShell 7+", "pwsh.exe", ["PowerShell/7/pwsh.exe"]),
    ("wt", "Windows Terminal", "wt.exe", []),
    ("git", "Git", "git.exe", []),
    ("node", "Node.js", "node.exe", []),
    ("python", "Python", "python.exe", []),
    ("ollama", "Ollama", "ollama.exe", ["Ollama/ollama.exe"]),
    ("lmstudio", "LM Studio", "LM Studio.exe", ["LM Studio/LM Studio.exe"]),
    # ComfyUI is typically a folder of code, not a single exe. Best-effort path glob:
    ("comfyui", "ComfyUI", None, []),  # detected separately via folder heuristic
]


def _make(id_: str, name: str, **kw) -> AppCapability:
    cap = AppCapability(
        id=f"app.{id_}", name=name,
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
        permission_profile=PermissionProfile(read_only=False, execute_confirm=True,
                                             notes="launching apps requires user confirmation"),
    )
    for k, v in kw.items():
        if hasattr(cap, k):
            setattr(cap, k, v)
        else:
            cap.metadata[k] = v
    return cap


def _scan_program_files(patterns: list[str]) -> str | None:
    for root in PROGRAM_FILES:
        if not root or not Path(root).exists():
            continue
        for pattern in patterns:
            try:
                for hit in Path(root).glob(pattern):
                    if hit.exists():
                        return str(hit)
            except Exception:
                continue
    return None


def _scan_comfyui_folder() -> str | None:
    """ComfyUI is usually a checked-out folder. Look in common spots."""
    candidates = [
        Path.home() / "ComfyUI",
        Path.home() / "Desktop" / "ComfyUI",
        Path.home() / "Documents" / "ComfyUI",
        Path("C:/ComfyUI"),
        Path("D:/ComfyUI"),
    ]
    for c in candidates:
        try:
            if c.exists() and (c / "main.py").exists():
                return str(c)
        except Exception:
            continue
    return None


def scan() -> tuple[list[AppCapability], ScannerReport]:
    t0 = time.time()
    caps: list[AppCapability] = []
    warnings: list[str] = []

    for id_, name, exe, patterns in APP_TARGETS:
        if id_ == "comfyui":
            folder = _scan_comfyui_folder()
            cap = _make(id_, name,
                        available=bool(folder),
                        confidence="high" if folder else "low",
                        detection_method="filesystem",
                        path=folder,
                        evidence=DetectionEvidence(method="filesystem",
                                                   detail=folder or "no ComfyUI folder in common locations"))
            caps.append(cap)
            continue

        path = shutil.which(exe) if exe else None
        method = "path" if path else None
        if not path and patterns:
            path = _scan_program_files(patterns)
            if path:
                method = "filesystem"
        cap = _make(id_, name,
                    available=bool(path),
                    confidence="high" if path else "low",
                    detection_method=method or "path",
                    path=path,
                    evidence=DetectionEvidence(
                        method=method or "path",
                        detail=path or f"not found via PATH or {len(patterns)} install-dir patterns",
                    ))
        caps.append(cap)

    duration_ms = (time.time() - t0) * 1000
    detected = sum(1 for c in caps if c.available)
    avg_conf = _avg_confidence(caps)
    report = ScannerReport(
        scanner=SCANNER, status="success",
        detected_count=detected, confidence_average=avg_conf,
        false_positive_risk="low",
        false_negative_risk="medium",  # we don't scan arbitrary install dirs
        duration_ms=duration_ms, warnings=warnings,
    )
    return caps, report


def _avg_confidence(caps: list) -> float:
    if not caps:
        return 0.0
    score = {"high": 1.0, "medium": 0.6, "low": 0.2}
    return round(sum(score.get(c.confidence, 0.0) for c in caps) / len(caps), 2)
