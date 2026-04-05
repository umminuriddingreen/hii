#!/usr/bin/env python3
"""Install direct 3D model runtimes for HII without ComfyUI."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HII_ROOT = Path(__file__).resolve().parents[1]
EXTERNAL_ROOT = HII_ROOT / "external"
TRIPOSR_REPO = EXTERNAL_ROOT / "TripoSR"
HUNYUAN_REPO = EXTERNAL_ROOT / "Hunyuan3D-2.1"
VENV_ROOT = EXTERNAL_ROOT / ".venvs"
TRIPOSR_VENV = VENV_ROOT / "triposr"
HUNYUAN_VENV = VENV_ROOT / "hunyuan3d"

TRIPOSR_PACKAGES = [
    "numpy<2",
    "Pillow==10.1.0",
    "omegaconf==2.3.0",
    "einops==0.7.0",
    "transformers==4.35.0",
    "trimesh==4.0.5",
    "rembg",
    "huggingface-hub",
    "imageio[ffmpeg]",
    "moderngl==5.10.0",
    "git+https://github.com/tatsy/torchmcubes.git",
]

TRIPOSR_OPTIONAL_PACKAGES = [
    "xatlas==0.0.9",
]

HUNYUAN_SHAPE_PACKAGES = [
    "numpy==1.24.4",
    "scipy==1.14.1",
    "Pillow",
    "PyYAML==6.0.2",
    "transformers==4.46.0",
    "diffusers==0.30.0",
    "accelerate==1.1.1",
    "huggingface-hub==0.30.2",
    "safetensors==0.4.4",
    "einops==0.8.0",
    "opencv-python==4.10.0.84",
    "imageio==2.36.0",
    "scikit-image==0.24.0",
    "rembg==2.0.65",
    "trimesh==4.4.7",
    "pymeshlab>=2023.12.post3",
    "pygltflib>=1.16.3",
    "omegaconf==2.3.0",
    "configargparse==1.7",
    "fastapi==0.115.12",
    "uvicorn==0.34.3",
    "tqdm==4.66.5",
    "psutil==6.0.0",
    "onnxruntime==1.16.3",
    "torchmetrics==1.6.0",
    "pydantic==2.10.6",
    "timm",
    "torchdiffeq",
]

HUNYUYAN_OPTIONAL_PACKAGES = [
    "xatlas==0.0.9",
]


def pick_python(*preferred: str) -> str:
    for candidate in (*preferred, sys.executable):
        path = shutil.which(candidate)
        if path:
            return path
    return sys.executable


def run(cmd: list[str], cwd: Path | None = None) -> None:
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def python_bin(venv_dir: Path) -> Path:
    return venv_dir / "bin" / "python"


def ensure_repo(path: Path, url: str) -> str:
    if path.exists():
        return "present"
    run(["git", "clone", url, str(path)])
    return "cloned"


def recreate_venv(venv_dir: Path, python_exe: str) -> None:
    if venv_dir.exists():
        shutil.rmtree(venv_dir)
    run([python_exe, "-m", "venv", str(venv_dir)])


def ensure_venv(venv_dir: Path, python_exe: str) -> None:
    py = python_bin(venv_dir)
    if not py.exists():
        recreate_venv(venv_dir, python_exe)
        return
    version = subprocess.check_output([str(py), "--version"], text=True).strip()
    expected = subprocess.check_output([python_exe, "--version"], text=True).strip()
    if version != expected:
        recreate_venv(venv_dir, python_exe)


def pip_install(venv_dir: Path, packages: list[str]) -> None:
    py = python_bin(venv_dir)
    run([str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
    run([str(py), "-m", "pip", "install", "torch", "torchvision"])
    run([str(py), "-m", "pip", "install", "numpy<2"])
    run([str(py), "-m", "pip", "install", *packages])


def pip_install_optional(venv_dir: Path, packages: list[str]) -> list[dict[str, str]]:
    py = python_bin(venv_dir)
    failures: list[dict[str, str]] = []
    for package in packages:
        try:
            run([str(py), "-m", "pip", "install", package])
        except subprocess.CalledProcessError as exc:
            failures.append({"package": package, "error": str(exc)})
    return failures


def install_triposr() -> dict:
    ensure_venv(TRIPOSR_VENV, pick_python("python3.10", "python3.11"))
    pip_install(TRIPOSR_VENV, TRIPOSR_PACKAGES)
    optional_failures = pip_install_optional(TRIPOSR_VENV, TRIPOSR_OPTIONAL_PACKAGES)
    return {
        "status": "installed",
        "repo": str(TRIPOSR_REPO),
        "venv": str(TRIPOSR_VENV),
        "python": str(python_bin(TRIPOSR_VENV)),
        "optional_failures": optional_failures,
    }


def install_hunyuan_shape() -> dict:
    ensure_venv(HUNYUAN_VENV, pick_python("python3.11", "python3.10"))
    pip_install(HUNYUAN_VENV, HUNYUAN_SHAPE_PACKAGES)
    optional_failures = pip_install_optional(HUNYUAN_VENV, HUNYUYAN_OPTIONAL_PACKAGES)
    return {
        "status": "installed-experimental",
        "repo": str(HUNYUAN_REPO),
        "venv": str(HUNYUAN_VENV),
        "python": str(python_bin(HUNYUAN_VENV)),
        "note": "Shape-only environment installed. Model config/weights layout still required for direct local execution.",
        "optional_failures": optional_failures,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Install direct 3D model runtimes for HII")
    ap.add_argument("--target", choices=["triposr", "hunyuan", "all"], default="all")
    ap.add_argument("--skip-clone", action="store_true", help="Assume repos already exist")
    ns = ap.parse_args()

    EXTERNAL_ROOT.mkdir(parents=True, exist_ok=True)
    VENV_ROOT.mkdir(parents=True, exist_ok=True)

    result: dict[str, object] = {
        "triposr_repo": str(TRIPOSR_REPO),
        "hunyuan_repo": str(HUNYUAN_REPO),
    }

    if not ns.skip_clone:
        result["triposr_clone"] = ensure_repo(TRIPOSR_REPO, "https://github.com/VAST-AI-Research/TripoSR")
        result["hunyuan_clone"] = ensure_repo(HUNYUAN_REPO, "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1")
    else:
        result["triposr_clone"] = "skipped"
        result["hunyuan_clone"] = "skipped"

    if ns.target in ("triposr", "all"):
        result["triposr"] = install_triposr()
    if ns.target in ("hunyuan", "all"):
        result["hunyuan"] = install_hunyuan_shape()

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
