"""
HII Agent Delegator

RULE: Local models are DUMB. They run scripts. Period.

Agent types:
- runner: execute a command, return output
- watcher: poll a resource on interval, report changes
- syncer: periodic sync operations (git, obsidian, backups)

All agents run as subprocesses managed by the daemon.
"""

import json
import subprocess
import time
from pathlib import Path
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional

HII_DIR = Path.home() / ".hii"
AGENTS_FILE = HII_DIR / "agents.json"


@dataclass
class AgentSpec:
    id: str
    name: str
    agent_type: str         # runner | watcher | syncer
    command: str            # exact command — no interpretation
    args: list[str] = field(default_factory=list)
    interval: Optional[int] = None  # seconds, for watchers
    cwd: Optional[str] = None
    active: bool = True
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class AgentResult:
    agent_id: str
    stdout: str
    stderr: str
    exit_code: Optional[int]
    timestamp: str


def _load() -> list[dict]:
    try:
        return json.loads(AGENTS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(agents: list[dict]):
    HII_DIR.mkdir(parents=True, exist_ok=True)
    AGENTS_FILE.write_text(json.dumps(agents, indent=2))


def register(name: str, agent_type: str, command: str,
             args: Optional[list[str]] = None, interval: Optional[int] = None,
             cwd: Optional[str] = None) -> AgentSpec:
    agents = _load()
    spec = AgentSpec(
        id=f"{agent_type}_{len(agents):03d}",
        name=name,
        agent_type=agent_type,
        command=command,
        args=args or [],
        interval=interval,
        cwd=cwd,
    )
    agents.append(asdict(spec))
    _save(agents)
    return spec


def list_agents(agent_type: Optional[str] = None, active_only: bool = True) -> list[AgentSpec]:
    agents = _load()
    if agent_type:
        agents = [a for a in agents if a.get("agent_type") == agent_type]
    if active_only:
        agents = [a for a in agents if a.get("active", True)]
    return [AgentSpec(**a) for a in agents]


def deactivate(agent_id: str):
    agents = _load()
    for a in agents:
        if a["id"] == agent_id:
            a["active"] = False
    _save(agents)


def run(spec: AgentSpec, timeout: int = 60) -> AgentResult:
    """Execute an agent's command and return result."""
    try:
        proc = subprocess.run(
            [spec.command] + spec.args,
            cwd=spec.cwd or str(Path.home()),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=isinstance(spec.command, str) and " " in spec.command,
        )
        return AgentResult(
            agent_id=spec.id,
            stdout=proc.stdout[:10_000],
            stderr=proc.stderr[:5_000],
            exit_code=proc.returncode,
            timestamp=datetime.now().isoformat(),
        )
    except subprocess.TimeoutExpired:
        return AgentResult(spec.id, "", "timeout", 1, datetime.now().isoformat())
    except Exception as e:
        return AgentResult(spec.id, "", str(e), 1, datetime.now().isoformat())


def run_watcher_cycle(spec: AgentSpec, cycles: int = 1) -> list[AgentResult]:
    """Run a watcher for N cycles."""
    results = []
    for _ in range(cycles):
        results.append(run(spec))
        if spec.interval and _ < cycles - 1:
            time.sleep(spec.interval)
    return results
