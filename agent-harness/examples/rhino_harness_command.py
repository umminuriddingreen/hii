#!/usr/bin/env python3
"""Rhino helper for HII Agent Harness."""
from __future__ import annotations

import os
import shlex
import subprocess
import tempfile

try:
    import rhinoscriptsyntax as rs
except ImportError as exc:
    raise SystemExit("This script must run inside Rhino's Python environment.") from exc

HARNESS_COMMAND = os.environ.get("HII_AGENT_HARNESS_COMMAND", "hii-agent-harness")
DEFAULT_OUTPUT = os.path.join(tempfile.gettempdir(), "hii-agent-harness-rhino-last.txt")


def _prompt() -> str | None:
    prompt = rs.StringBox("Ask Agent Harness", "", "HII Agent Harness")
    if prompt is None:
        return None
    prompt = prompt.strip()
    return prompt or None


def _run(prompt: str) -> tuple[int, str, str]:
    command = shlex.split(HARNESS_COMMAND) + ["comfy", "text2img", prompt, "--no-wait"]
    proc = subprocess.run(command, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def main() -> None:
    prompt = _prompt()
    if not prompt:
        print("Cancelled.")
        return
    code, stdout, stderr = _run(prompt)
    output = stdout or stderr or "(no output)"
    with open(DEFAULT_OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(output)
    print(output)
    if code != 0:
        rs.MessageBox(f"Command failed. Output saved to {DEFAULT_OUTPUT}", 0, "HII Agent Harness")
        return
    rs.MessageBox(output[:1200], 0, "HII Agent Harness")


if __name__ == "__main__":
    main()
