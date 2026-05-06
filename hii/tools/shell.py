"""Shell execution."""

from __future__ import annotations
import subprocess
from dataclasses import dataclass


@dataclass
class ShellResult:
    code: int
    stdout: str
    stderr: str


def run(cmd: str, cwd: str | None = None, timeout: int = 30) -> ShellResult:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                            cwd=cwd, timeout=timeout)
    return ShellResult(code=result.returncode, stdout=result.stdout, stderr=result.stderr)
