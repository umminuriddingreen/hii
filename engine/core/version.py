"""
HII Version Tracker

Auto-tracks changes to the HII workspace. Exposes as CLI.
Designed to be the easiest possible interface for Claude, humans, or any other agent.

Usage:
    hii-engine version              # show current version + recent changes
    hii-engine version snap "msg"   # snapshot current state with message
    hii-engine version log          # show version history
    hii-engine version diff         # show uncommitted changes
    hii-engine version auto         # auto-commit if there are changes (for cron/daemon)
"""

import os
import subprocess
import json
from pathlib import Path
from datetime import datetime

HII_ROOT = Path(os.environ.get("HII_ROOT", str(Path.home() / "hii")))
HII_DIR = Path.home() / ".hii"
VERSION_LOG = HII_DIR / "versions.json"


def _run(cmd: str, cwd: str | None = None) -> str:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           cwd=cwd or str(HII_ROOT), timeout=30)
        return r.stdout.strip()
    except Exception as e:
        return f"error: {e}"


def current() -> dict:
    """Current version state — compact, token-efficient."""
    branch = _run("git rev-parse --abbrev-ref HEAD")
    commit = _run("git log --oneline -1")
    dirty = _run("git status --short")
    pkg_version = "unknown"
    try:
        pkg = json.loads((HII_ROOT / "package.json").read_text())
        pkg_version = pkg.get("version", "unknown")
    except Exception:
        pass

    return {
        "version": pkg_version,
        "branch": branch,
        "commit": commit,
        "dirty": bool(dirty),
        "changes": dirty if dirty else None,
        "timestamp": datetime.now().isoformat(),
    }


def snap(message: str) -> str:
    """Snapshot: stage all, commit with message, log to version history."""
    dirty = _run("git status --short")
    if not dirty:
        return "clean — nothing to snap"

    _run("git add -A")
    _run(f'git commit -m "{message}\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"')
    commit = _run("git log --oneline -1")

    # Log to version history
    _log_version(message, commit)
    return f"snapped: {commit}"


def auto_snap() -> str:
    """Auto-snapshot if dirty. For daemon/cron use."""
    dirty = _run("git status --short")
    if not dirty:
        return "clean"
    # Count changed files for a meaningful message
    files = [l.strip() for l in dirty.split("\n") if l.strip()]
    msg = f"auto: {len(files)} file(s) changed"
    return snap(msg)


def log(n: int = 20) -> list[dict]:
    """Recent version history from git log."""
    raw = _run(f"git log --oneline -{n}")
    entries = []
    for line in raw.split("\n"):
        if line.strip():
            parts = line.split(" ", 1)
            entries.append({"hash": parts[0], "message": parts[1] if len(parts) > 1 else ""})
    return entries


def diff() -> str:
    """Show uncommitted changes."""
    staged = _run("git diff --cached --stat")
    unstaged = _run("git diff --stat")
    untracked = _run("git ls-files --others --exclude-standard")
    parts = []
    if staged:
        parts.append(f"Staged:\n{staged}")
    if unstaged:
        parts.append(f"Unstaged:\n{unstaged}")
    if untracked:
        parts.append(f"Untracked:\n{untracked}")
    return "\n".join(parts) if parts else "clean"


def _log_version(message: str, commit: str):
    """Append to persistent version log."""
    HII_DIR.mkdir(parents=True, exist_ok=True)
    history = []
    if VERSION_LOG.exists():
        try:
            history = json.loads(VERSION_LOG.read_text())
        except Exception:
            pass
    history.append({
        "timestamp": datetime.now().isoformat(),
        "commit": commit,
        "message": message,
    })
    # Keep last 200
    history = history[-200:]
    VERSION_LOG.write_text(json.dumps(history, indent=2))


if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "current"

    if cmd == "current" or cmd == "version":
        print(json.dumps(current(), indent=2))
    elif cmd == "snap":
        msg = " ".join(sys.argv[2:]) or f"snap {datetime.now().strftime('%H:%M')}"
        print(snap(msg))
    elif cmd == "auto":
        print(auto_snap())
    elif cmd == "log":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        for entry in log(n):
            print(f"  {entry['hash']} {entry['message']}")
    elif cmd == "diff":
        print(diff())
    else:
        print("Usage: version [current|snap <msg>|auto|log|diff]")
