"""Asset scanner — index passive outputs (images, renders, 3D files, logs)."""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

from .schema import (
    AssetCapability, DetectionEvidence, PermissionProfile, ScannerReport,
)

SCANNER = "assets"

MEDIA_BY_EXT: dict[str, str] = {
    # images
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tiff": "image", ".tif": "image",
    # video
    ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
    # 3d
    ".obj": "3d", ".stl": "3d", ".fbx": "3d", ".glb": "3d", ".gltf": "3d",
    ".3dm": "3d", ".3ds": "3d", ".dae": "3d", ".ply": "3d",
    # text / docs
    ".txt": "text", ".md": "text", ".pdf": "text", ".docx": "text",
    # logs / data
    ".log": "log", ".jsonl": "log",
    ".json": "json",
}

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".cache"}
MAX_FILES_DEFAULT = 500
MAX_DEPTH_DEFAULT = 4
HASH_SIZE_LIMIT = 8 * 1024 * 1024  # only hash files ≤ 8 MB


def _cheap_hash(path: Path) -> str | None:
    try:
        if path.stat().st_size > HASH_SIZE_LIMIT:
            return None
        h = hashlib.sha1()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:16]  # short digest is plenty for deduplication
    except OSError:
        return None


def _classify(path: Path) -> str:
    return MEDIA_BY_EXT.get(path.suffix.lower(), "unknown")


def _infer_source_skill(path: Path) -> str | None:
    """Cheap inference: if the artifact path passes through ~/.hii/artifacts/<skill>/, use that."""
    parts = path.parts
    try:
        idx = parts.index(".hii")
        if parts[idx + 1] == "artifacts" and idx + 2 < len(parts):
            return parts[idx + 2]
    except (ValueError, IndexError):
        pass
    # filename prefix
    name = path.stem
    for prefix in ("arch-design", "computer-use", "GreenSpire_Tower", "hii-"):
        if name.startswith(prefix):
            return prefix
    return None


def _make(path: Path) -> AssetCapability:
    try:
        st = path.stat()
        size = st.st_size
        mtime = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime))
    except OSError:
        size, mtime = 0, ""
    media = _classify(path)
    return AssetCapability(
        id=f"asset.{path.parent.name}.{path.name}",
        name=path.name,
        available=True, confidence="high", detection_method="filesystem",
        source_scanner=SCANNER, last_checked=time.strftime("%Y-%m-%dT%H:%M:%S"),
        path=str(path),
        media_type=media,
        size_bytes=size,
        modified_at=mtime,
        content_hash=_cheap_hash(path),
        likely_source_skill=_infer_source_skill(path),
        permission_profile=PermissionProfile(read_only=True,
                                             notes="passive asset — never executed"),
        evidence=DetectionEvidence(method="filesystem", detail=str(path)),
    )


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
                    elif entry.suffix.lower() in MEDIA_BY_EXT:
                        found.append(entry)
                        if len(found) >= max_files:
                            break
                except OSError:
                    continue
        except (PermissionError, OSError):
            continue
    return found


def scan(
    roots: list[Path] | None = None,
    max_files_per_root: int = MAX_FILES_DEFAULT,
    max_depth: int = MAX_DEPTH_DEFAULT,
) -> tuple[list[AssetCapability], ScannerReport]:
    t0 = time.time()
    caps: list[AssetCapability] = []
    warnings: list[str] = []

    if roots is None:
        roots = default_roots()

    for root in roots:
        found = _walk(root, max_files_per_root, max_depth)
        if len(found) >= max_files_per_root:
            warnings.append(f"truncated at {max_files_per_root} files in {root}")
        for p in found:
            try:
                caps.append(_make(p))
            except Exception as exc:
                warnings.append(f"{p}: {exc}")

    duration_ms = (time.time() - t0) * 1000
    report = ScannerReport(
        scanner=SCANNER, status="success" if caps else "partial",
        detected_count=len(caps),
        confidence_average=1.0 if caps else 0.0,
        false_positive_risk="low",
        false_negative_risk="medium",
        duration_ms=duration_ms, warnings=warnings,
    )
    return caps, report


def default_roots() -> list[Path]:
    roots = [Path.home() / ".hii" / "artifacts"]
    extras = [
        Path.home() / "Desktop" / "comfyui-building-design",
    ]
    for e in extras:
        if e.exists():
            roots.append(e)
    return [r for r in roots if r.exists()]
