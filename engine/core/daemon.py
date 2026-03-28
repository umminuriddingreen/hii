"""
HII Self-Healing Daemon

Unix-native process supervisor. Manages workers, restarts crashes,
maintains heartbeat. Designed to run as a launchd service on macOS.

Usage:
    python -m engine.core.daemon start
    python -m engine.core.daemon stop
    python -m engine.core.daemon status
"""

import os
import sys
import json
import time
import signal
import subprocess
import logging
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

HII_DIR = Path.home() / ".hii"
PID_FILE = HII_DIR / "daemon.pid"
LOG_FILE = HII_DIR / "daemon.log"
WORKERS_FILE = HII_DIR / "workers.json"

HII_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("hii.daemon")


@dataclass
class WorkerSpec:
    id: str
    command: str
    args: list[str] = field(default_factory=list)
    restart_on_crash: bool = True
    max_restarts: int = 5
    cwd: Optional[str] = None


@dataclass
class WorkerState:
    spec: WorkerSpec
    pid: Optional[int] = None
    restarts: int = 0
    last_start: float = 0
    alive: bool = False


class Daemon:
    def __init__(self):
        self.workers: dict[str, WorkerState] = {}
        self.procs: dict[str, subprocess.Popen] = {}
        self.running = False
        self._intent_engine = None
        self._last_intent_cycle: float = 0

    def start(self):
        """Write PID, register signals, enter heartbeat loop."""
        self.running = True
        PID_FILE.write_text(str(os.getpid()))
        log.info(f"daemon started pid={os.getpid()}")

        signal.signal(signal.SIGTERM, lambda *_: self.shutdown("SIGTERM"))
        signal.signal(signal.SIGINT, lambda *_: self.shutdown("SIGINT"))

        # Load any persisted worker specs
        self._load_workers()

        # Heartbeat loop
        while self.running:
            self._heartbeat()
            time.sleep(10)

    def shutdown(self, reason: str):
        log.info(f"shutdown reason={reason}")
        self.running = False
        for wid, proc in self.procs.items():
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
            log.info(f"killed worker={wid}")
        try:
            PID_FILE.unlink()
        except FileNotFoundError:
            pass
        sys.exit(0)

    def spawn(self, spec: WorkerSpec):
        """Register and start a worker."""
        state = WorkerState(spec=spec)
        self.workers[spec.id] = state
        self._start_worker(state)
        self._save_workers()

    def _start_worker(self, state: WorkerState):
        spec = state.spec
        log.info(f"spawning worker={spec.id} cmd={spec.command}")
        try:
            proc = subprocess.Popen(
                [spec.command] + spec.args,
                cwd=spec.cwd or str(Path.home()),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            self.procs[spec.id] = proc
            state.pid = proc.pid
            state.last_start = time.time()
            state.alive = True
        except Exception as e:
            log.error(f"failed to spawn worker={spec.id}: {e}")
            state.alive = False

    def _heartbeat(self):
        # Intent engine cycle (time-gated)
        intent_interval = int(os.environ.get("HII_INTENT_INTERVAL", "60"))
        now = time.time()
        if now - self._last_intent_cycle >= intent_interval:
            self._last_intent_cycle = now
            try:
                if self._intent_engine is None:
                    from engine.core.intent import IntentEngine
                    self._intent_engine = IntentEngine()
                self._intent_engine.cycle()
            except Exception as e:
                log.error(f"intent engine error: {e}")

        for wid, state in self.workers.items():
            proc = self.procs.get(wid)
            if proc is None or proc.poll() is not None:
                state.alive = False
                if state.spec.restart_on_crash and state.restarts < state.spec.max_restarts:
                    state.restarts += 1
                    delay = 2 * state.restarts
                    log.info(f"restarting worker={wid} attempt={state.restarts} delay={delay}s")
                    time.sleep(delay)
                    self._start_worker(state)
                elif state.restarts >= state.spec.max_restarts:
                    log.warning(f"worker={wid} exceeded max restarts")

    def status(self) -> dict:
        return {
            "pid": os.getpid(),
            "workers": {
                wid: {
                    "pid": s.pid,
                    "alive": s.alive,
                    "restarts": s.restarts,
                }
                for wid, s in self.workers.items()
            },
        }

    def _save_workers(self):
        specs = [asdict(s.spec) for s in self.workers.values()]
        WORKERS_FILE.write_text(json.dumps(specs, indent=2))

    def _load_workers(self):
        loaded = False
        if WORKERS_FILE.exists():
            try:
                specs = json.loads(WORKERS_FILE.read_text())
                if specs:
                    loaded = True
                for raw in specs:
                    spec = WorkerSpec(**raw)
                    self.spawn(spec)
            except Exception as e:
                log.error(f"failed to load workers: {e}")
        # Auto-register default dashboard worker if nothing configured
        if not loaded and "hii-dashboard" not in self.workers:
            hii_root = str(Path(__file__).resolve().parent.parent.parent)
            default_spec = WorkerSpec(
                id="hii-dashboard",
                command="python3",
                args=["-m", "engine.serve.server"],
                restart_on_crash=True,
                max_restarts=10,
                cwd=hii_root,
            )
            self.spawn(default_spec)


def is_running() -> tuple[bool, Optional[int]]:
    """Check if daemon is alive by PID file."""
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)  # signal 0 = check existence
        return True, pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False, None


def start_background() -> int:
    """Fork the daemon into the background and return its PID.

    Redirects stdout/stderr to the daemon log file. If the daemon is
    already running, returns the existing PID without spawning a second
    instance.
    """
    running, pid = is_running()
    if running:
        return pid

    child = os.fork()
    if child > 0:
        # Parent — wait briefly for PID file to appear, then return child PID
        for _ in range(20):
            time.sleep(0.1)
            r, p = is_running()
            if r:
                return p
        return child

    # First child — new session
    os.setsid()
    grandchild = os.fork()
    if grandchild > 0:
        os._exit(0)

    # Grandchild — redirect stdio to log, then run daemon
    sys.stdout.flush()
    sys.stderr.flush()
    log_fd = open(str(LOG_FILE), "a")
    os.dup2(log_fd.fileno(), sys.stdout.fileno())
    os.dup2(log_fd.fileno(), sys.stderr.fileno())
    devnull = open(os.devnull, "r")
    os.dup2(devnull.fileno(), sys.stdin.fileno())

    d = Daemon()
    # Auto-register default dashboard worker if no workers configured
    if not WORKERS_FILE.exists() or not json.loads(WORKERS_FILE.read_text() or "[]"):
        hii_root = str(Path(__file__).resolve().parent.parent.parent)
        default_spec = WorkerSpec(
            id="hii-dashboard",
            command="python3",
            args=["-m", "engine.serve.server"],
            restart_on_crash=True,
            max_restarts=10,
            cwd=hii_root,
        )
        d.workers[default_spec.id] = WorkerState(spec=default_spec)
    d.start()
    os._exit(0)


def read_logs(lines: int = 50) -> str:
    try:
        all_lines = LOG_FILE.read_text().splitlines()
        return "\n".join(all_lines[-lines:])
    except FileNotFoundError:
        return "(no logs)"


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"

    if cmd == "start":
        running, pid = is_running()
        if running:
            print(f"daemon already running pid={pid}")
            sys.exit(0)
        print("starting hii daemon...")
        # Fork to background
        if os.fork() > 0:
            sys.exit(0)
        os.setsid()
        if os.fork() > 0:
            sys.exit(0)
        Daemon().start()

    elif cmd == "stop":
        running, pid = is_running()
        if not running:
            print("daemon not running")
            sys.exit(0)
        os.kill(pid, signal.SIGTERM)
        print(f"sent SIGTERM to pid={pid}")

    elif cmd == "status":
        running, pid = is_running()
        if running:
            print(f"daemon running pid={pid}")
        else:
            print("daemon not running")

    elif cmd == "logs":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 50
        print(read_logs(n))
