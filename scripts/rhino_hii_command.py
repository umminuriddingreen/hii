#!/usr/bin/env python3
"""Rhino-side HII command launcher.

Run inside Rhino via RunPythonScript. Prompts for a request, calls the local
HII CLI, prints the result to Rhino's command history, and stores the full
response in /tmp for inspection.
"""
from __future__ import annotations

import os
import subprocess
import tempfile

try:
    import rhinoscriptsyntax as rs
except ImportError as exc:  # pragma: no cover - only valid inside Rhino
    raise SystemExit("This script must run inside Rhino's Python environment.") from exc


HII_ROOT = os.path.expanduser(os.environ.get("HII_ROOT", "~/hii"))
DEFAULT_OUTPUT = os.path.join(tempfile.gettempdir(), "hii-rhino-last.txt")


def _prompt() -> str | None:
    prompt = rs.StringBox(
        "Ask HII",
        "",
        "HII from Rhino",
    )
    if prompt is None:
        return None
    prompt = prompt.strip()
    return prompt or None


def _run_hii(prompt: str) -> tuple[int, str, str]:
    command = [
        "/bin/zsh",
        "-lc",
        f'cd "{HII_ROOT}" && node dist/cli.js chat "{prompt.replace(chr(34), chr(92) + chr(34))}"',
    ]
    proc = subprocess.run(command, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def main() -> None:
    prompt = _prompt()
    if not prompt:
        print("HII cancelled.")
        return

    print(f"HII prompt: {prompt}")
    code, stdout, stderr = _run_hii(prompt)
    output = stdout or stderr or "(no output)"

    try:
        with open(DEFAULT_OUTPUT, "w", encoding="utf-8") as fh:
            fh.write(output)
    except Exception:
        pass

    print("\n=== HII ===")
    print(output)
    print(f"\nSaved full output to {DEFAULT_OUTPUT}")

    if code != 0:
        rs.MessageBox(
            f"HII failed.\n\nSaved output to:\n{DEFAULT_OUTPUT}",
            0,
            "HII from Rhino",
        )
        return

    preview = output[:1200] + ("…" if len(output) > 1200 else "")
    rs.MessageBox(preview, 0, "HII from Rhino")


if __name__ == "__main__":
    main()
