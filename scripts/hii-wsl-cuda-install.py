#!/usr/bin/env python3
"""Install a checksum-verified CUDA SDK in HII's isolated Linux runtime.

No NVIDIA driver, Python packages, model weights or system CUDA paths change.
Requires Python 3.12+, cmake, ninja, GCC and a pinned llama.cpp checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

BASE = "https://developer.download.nvidia.com/compute/cuda/redist/"
VERSION = "12.9.1"
COMPONENTS = ("cuda_nvcc", "cuda_cudart", "cuda_cccl", "libcublas")


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, destination, expected):
    if destination.exists() and sha256(destination) == expected:
        return
    partial = destination.with_suffix(destination.suffix + ".partial")
    print(f"Downloading {destination.name}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as source, partial.open("wb") as target:
        shutil.copyfileobj(source, target, 4 * 1024 * 1024)
    if sha256(partial) != expected:
        raise RuntimeError(f"Checksum mismatch: {partial}")
    partial.replace(destination)


def prepare_downloads(cache):
    cache.mkdir(parents=True, exist_ok=True)
    manifest_path = cache / f"redistrib_{VERSION}.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        with urllib.request.urlopen(BASE + f"redistrib_{VERSION}.json", timeout=30) as response:
            manifest = json.load(response)
        manifest_path.write_text(json.dumps(manifest))
    for component in COMPONENTS:
        entry = manifest[component]["linux-x86_64"]
        download(BASE + entry["relative_path"], cache / Path(entry["relative_path"]).name, entry["sha256"])
    return manifest


def install(prefix, jobs, cache):
    if sys.platform != "linux" or not prefix.is_absolute():
        raise RuntimeError("Run in WSL with an absolute isolated runtime prefix")
    prefix.mkdir(parents=True, exist_ok=True)
    source = prefix / "llama.cpp"
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if not revision.startswith("6a1a922d2"):
        raise RuntimeError("Expected llama.cpp b10819 (6a1a922d2), matching the native rail")
    for binary in ("cmake", "ninja", "g++"):
        if not shutil.which(binary):
            raise RuntimeError(f"Missing build dependency: {binary}")
    manifest = prepare_downloads(cache)
    sdk = prefix / "cuda"
    cache.mkdir(exist_ok=True)
    sdk.mkdir(exist_ok=True)
    entries = []
    for component in COMPONENTS:
        entry = manifest[component]["linux-x86_64"]
        archive = cache / Path(entry["relative_path"]).name
        download(BASE + entry["relative_path"], archive, entry["sha256"])
        marker = sdk / f".{component}.sha256"
        if not marker.exists() or marker.read_text().strip() != entry["sha256"]:
            print(f"Extracting {component}", flush=True)
            extraction = prefix / "packages" / component
            extraction.mkdir(parents=True, exist_ok=True)
            with tarfile.open(archive) as bundle:
                bundle.extractall(extraction, filter="data")
            roots = [item for item in extraction.iterdir() if item.is_dir()]
            if len(roots) != 1:
                raise RuntimeError(f"Unexpected archive layout for {component}")
            shutil.copytree(roots[0], sdk, dirs_exist_ok=True, symlinks=True)
            marker.write_text(entry["sha256"] + "\n")
        entries.append({"component": component, "sha256": entry["sha256"], "bytes": int(entry["size"])})
    # NVIDIA redistributables use lib/, while nvcc's Linux link defaults use lib64/.
    if not (sdk / "lib64").exists():
        (sdk / "lib64").symlink_to("lib", target_is_directory=True)
    env = dict(os.environ)
    env["PATH"] = str(sdk / "bin") + os.pathsep + env["PATH"]
    env["LD_LIBRARY_PATH"] = str(sdk / "lib") + ":/usr/lib/wsl/lib"
    env["CUDACXX"] = str(sdk / "bin/nvcc")
    build = source / "build-hii"
    subprocess.run(["cmake", "-S", str(source), "-B", str(build), "-G", "Ninja",
                    "-DCMAKE_BUILD_TYPE=Release", "-DGGML_CUDA=ON", "-DCMAKE_CUDA_ARCHITECTURES=120",
                    f"-DCUDAToolkit_ROOT={sdk}", "-DLLAMA_BUILD_TESTS=OFF",
                    "-DLLAMA_OPENSSL=OFF", f"-DCMAKE_BUILD_RPATH={sdk / 'lib'}"], env=env, check=True)
    subprocess.run(["cmake", "--build", str(build), "--target", "llama-server", "llama-bench",
                    "--parallel", str(jobs)], env=env, check=True)
    binary = build / "bin/llama-server"
    subprocess.run([str(binary), "--version"], env=env, check=True)
    (prefix / "install-receipt.json").write_text(json.dumps({
        "schemaVersion": 1, "cuda": VERSION, "revision": revision,
        "architecture": "sm_120", "components": entries, "binary": str(binary),
        "driverChanged": False, "weightsDownloaded": False,
    }, indent=2) + "\n")
    print(f"Installed: {binary}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 16:
        parser.error("--jobs must be between 1 and 16")
    cache = args.cache or args.prefix / "downloads"
    if args.download_only:
        prepare_downloads(cache)
    else:
        install(args.prefix, args.jobs, cache)
