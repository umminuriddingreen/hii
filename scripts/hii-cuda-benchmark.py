#!/usr/bin/env python3
"""Bounded same-weight CUDA microbenchmark. Does not stop or alter any service.

Unload the idle model from its serving runtime first. Run once per backend,
serially, with the same options and no competing model or GPU generation job.
Microbenchmarks measure inference, not agent correctness or server latency.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time


def run(args):
    if args.output.exists():
        raise RuntimeError("Refusing to overwrite a benchmark receipt")
    model = Path(args.model)
    if not model.is_file():
        raise RuntimeError("Model must be an existing local GGUF")
    command = [args.binary] + (["bench"] if args.unified else []) + [
        "-m", str(model), "-p", "512", "-n", "128", "-pg", "4096,128",
        "-r", "3", "-b", str(args.batch), "-ub", str(args.ubatch),
        "-t", str(args.threads), "-ngl", "999", "-fa", "on",
        "-ctk", "q4_0", "-ctv", "q4_0", "-o", "json", "--offline",
    ]
    started = time.time()
    proc = subprocess.run(command, text=True, capture_output=True, timeout=300)
    if proc.returncode:
        raise RuntimeError(f"Benchmark failed ({proc.returncode}): {proc.stderr[-2000:]}")
    rows = json.loads(proc.stdout)
    if not rows or any(row.get("n_gpu_layers") != 999 for row in rows):
        raise RuntimeError("Benchmark did not report the requested GPU configuration")
    report = {
        "schemaVersion": 1, "kind": "hii.cuda.microbenchmark", "backend": args.backend,
        "modelPath": str(model), "modelBytes": model.stat().st_size,
        "startedAtUnix": started, "finishedAtUnix": time.time(),
        "command": command, "rows": rows, "diagnostic": proc.stderr[-2000:],
        "scope": "Warm microbenchmark; excludes model loading and does not establish agent correctness",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as target:
        json.dump(report, target, indent=2)
    for row in rows:
        print(json.dumps({key: row.get(key) for key in (
            "build_commit", "n_prompt", "n_gen", "avg_ts", "stddev_ts", "samples_ts",
        )}), flush=True)
    print(f"Receipt: {args.output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--backend", required=True, choices=("native-cuda", "wsl-cuda"))
    parser.add_argument("--unified", action="store_true")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--ubatch", type=int, default=128)
    parser.add_argument("--threads", type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.threads <= 64 or not 32 <= args.ubatch <= args.batch <= 2048:
        parser.error("Invalid bounded thread/batch configuration")
    run(args)
