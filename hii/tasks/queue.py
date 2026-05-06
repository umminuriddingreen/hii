"""
HII Task Queue — File-backed persistent job queue.

Tasks route to:
- 'local': Ollama/local models — SCRIPTS ONLY, never reasoning
- 'architect': Claude/remote — complex reasoning, design, strategy

Design: JSON file queue. Simple. No Redis, no Celery, no overhead.
"""

import json
import uuid
from pathlib import Path
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional
from enum import Enum

HII_DIR = Path.home() / ".hii"
QUEUE_FILE = HII_DIR / "taskq.json"


class Target(str, Enum):
    LOCAL = "local"
    ARCHITECT = "architect"


class Status(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass
class Task:
    id: str
    name: str
    target: str
    status: str = "queued"
    script: Optional[str] = None     # for local: the exact command
    prompt: Optional[str] = None     # for architect: the intent
    result: Optional[str] = None
    error: Optional[str] = None
    retries: int = 0
    max_retries: int = 2
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


def _load() -> list[dict]:
    try:
        return json.loads(QUEUE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(tasks: list[dict]):
    HII_DIR.mkdir(parents=True, exist_ok=True)
    QUEUE_FILE.write_text(json.dumps(tasks, indent=2))


def add(name: str, target: str, script: Optional[str] = None,
        prompt: Optional[str] = None, max_retries: int = 2) -> Task:
    """Add a task. Local tasks MUST have a script."""
    if target == Target.LOCAL and not script:
        raise ValueError("Local tasks MUST have a predetermined script. Local models don't reason.")

    task = Task(
        id=uuid.uuid4().hex[:8],
        name=name,
        target=target,
        script=script,
        prompt=prompt,
        max_retries=max_retries,
    )
    q = _load()
    q.append(asdict(task))
    _save(q)
    return task


def list_tasks(status: Optional[str] = None, target: Optional[str] = None) -> list[Task]:
    q = _load()
    if status:
        q = [t for t in q if t.get("status") == status]
    if target:
        q = [t for t in q if t.get("target") == target]
    return [Task(**t) for t in q]


def claim_next(target: str) -> Optional[Task]:
    """Claim next queued task for given target."""
    q = _load()
    for t in q:
        if t["status"] == "queued" and t["target"] == target:
            t["status"] = "running"
            t["started_at"] = datetime.now().isoformat()
            _save(q)
            return Task(**t)
    return None


def complete(task_id: str, result: str):
    q = _load()
    for t in q:
        if t["id"] == task_id:
            t["status"] = "done"
            t["result"] = result
            t["completed_at"] = datetime.now().isoformat()
    _save(q)


def fail(task_id: str, error: str):
    q = _load()
    for t in q:
        if t["id"] == task_id:
            t["retries"] = t.get("retries", 0) + 1
            if t["retries"] >= t.get("max_retries", 2):
                t["status"] = "failed"
                t["error"] = error
                t["completed_at"] = datetime.now().isoformat()
            else:
                t["status"] = "queued"  # re-queue
    _save(q)


def purge_done() -> int:
    q = _load()
    before = len(q)
    q = [t for t in q if t.get("status") != "done"]
    _save(q)
    return before - len(q)
