#!/usr/bin/env python3
"""Quick, repeatable wall-clock benchmark for HII, Ollama, and Pi.

This measures the installed command-line stacks end to end. It does not claim
model parity: each runner's model and command are recorded in the result.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import statistics
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_PROMPT = "Reply with exactly these three words: local inference works"
DEFAULT_EXPECTED = "local inference works"
ANSI_ESCAPE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_once(name: str, command: list[str], timeout: float, expected: str | None) -> dict[str, Any]:
    started_at = utc_now()
    start = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "NO_COLOR": "1"},
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        output = completed.stdout.strip()
        error = completed.stderr.strip()
        clean_output = ANSI_ESCAPE.sub("", output).strip()
        return {
            "runner": name,
            "startedAt": started_at,
            "durationMs": round(elapsed_ms, 2),
            "exitCode": completed.returncode,
            "success": completed.returncode == 0 and bool(output),
            "exactMatch": clean_output == expected if expected is not None else None,
            "output": output,
            "stderr": error,
        }
    except subprocess.TimeoutExpired as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000
        return {
            "runner": name,
            "startedAt": started_at,
            "durationMs": round(elapsed_ms, 2),
            "exitCode": None,
            "success": False,
            "exactMatch": False if expected is not None else None,
            "output": (exc.stdout or "").strip() if isinstance(exc.stdout, str) else "",
            "stderr": f"timed out after {timeout:g}s",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument(
        "--expect",
        default=DEFAULT_EXPECTED,
        help="exact expected output; pass an empty string to disable correctness checking",
    )
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--hii-model", default="mlx-community/Qwen3.5-9B-MLX-4bit")
    parser.add_argument("--ollama-model", default="qwen3.8:27b-mlx")
    parser.add_argument("--pi-provider", default="hii-native")
    parser.add_argument("--pi-model", default="mlx-community/Qwen3.5-9B-MLX-4bit")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.runs < 1:
        parser.error("--runs must be at least 1")

    runners = [
        {
            "name": "hii",
            "model": args.hii_model,
            "command": ["hii", "ask", "--model", args.hii_model, "--no-hooks", args.prompt],
        },
        {
            "name": "ollama",
            "model": args.ollama_model,
            "command": ["ollama", "run", args.ollama_model, args.prompt],
        },
        {
            "name": "pi",
            "model": f"{args.pi_provider}/{args.pi_model}",
            "command": [
                "pi", "--print", "--no-session", "--no-tools", "--no-skills",
                "--no-extensions", "--no-context-files", "--provider", args.pi_provider,
                "--model", args.pi_model, "--system-prompt", "Answer directly and concisely.",
                args.prompt,
            ],
        },
    ]

    missing = [r["name"] for r in runners if not shutil_which(r["command"][0])]
    if missing:
        parser.error(f"missing executable(s): {', '.join(missing)}")

    results: list[dict[str, Any]] = []
    for iteration in range(1, args.runs + 1):
        for runner in runners:
            print(f"[{iteration}/{args.runs}] {runner['name']}...", flush=True)
            expected = args.expect if args.expect else None
            result = run_once(runner["name"], runner["command"], args.timeout, expected)
            result.update({"iteration": iteration, "model": runner["model"]})
            results.append(result)
            status = "ok" if result["success"] else "FAIL"
            print(f"  {status} {result['durationMs']:.0f} ms", flush=True)

    summary = []
    for runner in runners:
        samples = [r for r in results if r["runner"] == runner["name"]]
        successful = [r["durationMs"] for r in samples if r["success"]]
        summary.append(
            {
                "runner": runner["name"],
                "model": runner["model"],
                "successfulRuns": len(successful),
                "totalRuns": len(samples),
                "exactMatches": sum(r["exactMatch"] is True for r in samples),
                "medianMs": round(statistics.median(successful), 2) if successful else None,
                "minMs": round(min(successful), 2) if successful else None,
                "maxMs": round(max(successful), 2) if successful else None,
                "command": shlex.join(runner["command"][:-1] + ["<prompt>"]),
            }
        )

    report = {
        "schemaVersion": 1,
        "kind": "hii.cli-stack-benchmark",
        "generatedAt": utc_now(),
        "measurement": "end-to-end subprocess wall-clock time",
        "prompt": args.prompt,
        "expectedOutput": args.expect or None,
        "note": "Models may differ. Compare stack latency only when model identity and runtime conditions are acceptable.",
        "summary": summary,
        "runs": results,
    }
    output = args.output or Path("artifacts/benchmarks") / f"hii-ollama-pi-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")

    print("\nrunner   success   exact   median ms   model")
    for row in summary:
        median = f"{row['medianMs']:.2f}" if row["medianMs"] is not None else "-"
        print(
            f"{row['runner']:<8} {row['successfulRuns']}/{row['totalRuns']:<7} "
            f"{row['exactMatches']}/{row['totalRuns']:<5} {median:>9}   {row['model']}"
        )
    print(f"\nreport: {output.resolve()}")
    return 0 if all(row["successfulRuns"] == row["totalRuns"] for row in summary) else 1


def shutil_which(executable: str) -> str | None:
    # Kept local to avoid importing a module for one small preflight operation.
    paths = os.environ.get("PATH", "").split(os.pathsep)
    return next(
        (str(candidate) for root in paths if (candidate := Path(root) / executable).is_file() and os.access(candidate, os.X_OK)),
        None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
