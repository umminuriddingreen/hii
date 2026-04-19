"""
Executes routed intents across HII, Hermes, shell, and apps.
"""

import subprocess
import sys
import json
from pathlib import Path


def execute(route_result: dict) -> dict:
    """Execute a routed intent. Returns {"ok": bool, "output": str}."""
    route = route_result.get("route", "hermes")

    try:
        if route == "hii_skill":
            return _run_hii_skill(route_result)
        elif route == "hii_task":
            return _run_hii_task(route_result)
        elif route == "hermes":
            return _run_hermes(route_result)
        elif route == "shell":
            return _run_shell(route_result)
        elif route == "app":
            return _run_app(route_result)
        else:
            return {"ok": False, "output": f"Unknown route: {route}"}
    except Exception as e:
        return {"ok": False, "output": str(e)}


def _run_hii_skill(r: dict) -> dict:
    skill_id = r.get("skill_id")
    if not skill_id:
        return _run_hermes(r)  # fallback

    params = r.get("params", {})
    args = []
    for k, v in params.items():
        args.extend([f"--{k}", str(v)])

    result = subprocess.run(
        [sys.executable, "-m", "engine.cli", "skill", "run", "--id", skill_id] + args,
        capture_output=True, text=True, cwd=str(Path(__file__).resolve().parent.parent.parent),
    )
    output = result.stdout.strip() or result.stderr.strip()
    return {"ok": result.returncode == 0, "output": output}


def _run_hii_task(r: dict) -> dict:
    intent = r.get("intent", "")
    result = subprocess.run(
        [sys.executable, "-m", "engine.cli", "task", "add",
         "--name", intent, "--target", "local"],
        capture_output=True, text=True, cwd=str(Path(__file__).resolve().parent.parent.parent),
    )
    output = result.stdout.strip() or result.stderr.strip()
    return {"ok": result.returncode == 0, "output": f"Task queued: {intent}\n{output}"}


def _run_hermes(r: dict) -> dict:
    intent = r.get("intent", "")
    # Use Claude Code CLI in non-interactive print mode
    result = subprocess.run(
        ["claude", "-p", intent],
        capture_output=True, text=True, timeout=120,
    )
    output = result.stdout.strip()
    return {"ok": result.returncode == 0, "output": output}


def _run_shell(r: dict) -> dict:
    cmd = r.get("command")
    if not cmd:
        return {"ok": False, "output": "No command extracted"}

    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
    output = result.stdout.strip() or result.stderr.strip()
    return {"ok": result.returncode == 0, "output": output}


def _run_app(r: dict) -> dict:
    app = r.get("app", "")
    if not app:
        return {"ok": False, "output": "No app specified"}

    result = subprocess.run(["open", "-a", app], capture_output=True, text=True)
    return {"ok": result.returncode == 0, "output": f"Opened {app}"}
