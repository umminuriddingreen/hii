#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import shutil
from pathlib import Path


ROOT = Path.home() / ".hii" / "services" / "searxng"
SRC = ROOT / "src"
VENV = ROOT / "venv"
SETTINGS = ROOT / "settings.yml"
LOG = ROOT / "searxng.log"
PID = ROOT / "searxng.pid"
DEFAULT_URL = "http://127.0.0.1:8888"
REPO_URL = "https://github.com/searxng/searxng.git"

SETTINGS_TEMPLATE = """use_default_settings: true

general:
  debug: false
  instance_name: "HII Local Search"

search:
  safe_search: 0
  autocomplete: "duckduckgo"
  default_lang: "auto"
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"
  secret_key: "{secret}"

valkey:
  url: false
"""


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
  subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=True)


def python_for_venv() -> str:
  for candidate in ("python3.11", "python3.10", sys.executable):
    resolved = shutil.which(candidate)
    if resolved:
      return resolved
  return sys.executable


def venv_ready() -> bool:
  return (VENV / "bin" / "pip").exists() and (VENV / "bin" / "python").exists()


def write_settings() -> None:
  ROOT.mkdir(parents=True, exist_ok=True)
  if SETTINGS.exists():
    return
  SETTINGS.write_text(SETTINGS_TEMPLATE.format(secret=secrets.token_hex(24)), encoding="utf-8")


def bootstrap() -> None:
  ROOT.mkdir(parents=True, exist_ok=True)
  write_settings()
  if not SRC.exists():
    run(["git", "clone", REPO_URL, str(SRC)])
  else:
    run(["git", "pull", "--ff-only"], cwd=SRC)
  if VENV.exists() and not venv_ready():
    shutil.rmtree(VENV)
  if not VENV.exists():
    run([python_for_venv(), "-m", "venv", str(VENV)])
  pip = VENV / "bin" / "pip"
  run([str(pip), "install", "-U", "pip", "setuptools", "wheel", "pyyaml", "msgspec", "typing-extensions", "pybind11"])
  run([str(pip), "install", "--use-pep517", "--no-build-isolation", "-e", "."], cwd=SRC)


def pid_is_running(pid_value: int) -> bool:
  try:
    os.kill(pid_value, 0)
    return True
  except OSError:
    return False


def read_pid() -> int | None:
  if not PID.exists():
    return None
  try:
    value = int(PID.read_text(encoding="utf-8").strip())
  except ValueError:
    return None
  return value if pid_is_running(value) else None


def port_open(host: str = "127.0.0.1", port: int = 8888) -> bool:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.5)
    return sock.connect_ex((host, port)) == 0


def start() -> None:
  if read_pid():
    print(f"already-running {DEFAULT_URL}")
    return
  if not SRC.exists() or not VENV.exists():
    raise SystemExit("bootstrap required: run `python3 scripts/searxng_local.py bootstrap` first")
  ROOT.mkdir(parents=True, exist_ok=True)
  write_settings()
  env = os.environ.copy()
  env["SEARXNG_SETTINGS_PATH"] = str(SETTINGS)
  env["PYTHONUNBUFFERED"] = "1"
  python_bin = VENV / "bin" / "python"
  with LOG.open("ab") as log_handle:
    proc = subprocess.Popen(
      [str(python_bin), "searx/webapp.py"],
      cwd=str(SRC),
      env=env,
      stdout=log_handle,
      stderr=subprocess.STDOUT,
      start_new_session=True,
    )
  PID.write_text(str(proc.pid), encoding="utf-8")
  for _ in range(40):
    if port_open():
      print(f"started {DEFAULT_URL}")
      return
    time.sleep(0.25)
  raise SystemExit(f"searxng failed to start, inspect {LOG}")


def stop() -> None:
  current = read_pid()
  if not current:
    PID.unlink(missing_ok=True)
    print("not-running")
    return
  os.kill(current, signal.SIGTERM)
  for _ in range(20):
    if not pid_is_running(current):
      PID.unlink(missing_ok=True)
      print("stopped")
      return
    time.sleep(0.25)
  os.kill(current, signal.SIGKILL)
  PID.unlink(missing_ok=True)
  print("killed")


def status() -> None:
  current = read_pid()
  print(f"url={DEFAULT_URL}")
  print(f"repo={SRC}")
  print(f"venv={VENV}")
  print(f"settings={SETTINGS}")
  print(f"log={LOG}")
  print(f"pid={current or 'none'}")
  print(f"ready={'yes' if port_open() else 'no'}")


def main() -> None:
  parser = argparse.ArgumentParser(description="Manage local non-Docker SearXNG for HII")
  parser.add_argument("action", choices=["bootstrap", "start", "stop", "restart", "status"])
  args = parser.parse_args()

  if args.action == "bootstrap":
    bootstrap()
  elif args.action == "start":
    start()
  elif args.action == "stop":
    stop()
  elif args.action == "restart":
    stop()
    start()
  elif args.action == "status":
    status()


if __name__ == "__main__":
  main()
