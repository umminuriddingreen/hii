"""
HII Intent Engine — The autonomous brain.

Reads psyche + observations -> derives intent -> acts -> reflects.
This is what makes HII self-building and self-healing.

The intent loop runs inside the daemon, executing every N seconds.
It observes system state, identifies what needs attention, and
takes action — registering new skills, restarting crashed workers,
cleaning dirty git state, filling capability gaps.

Usage:
    python3 -m engine.core.intent          # run one cycle
    python3 -m engine.core.intent loop     # run continuous loop
    python3 -m engine.core.intent status   # show current intents
"""

import json
import logging
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional

HII_DIR = Path.home() / ".hii"
HII_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = HII_DIR / "intent_state.json"
LOG_FILE = HII_DIR / "intent.log"
HII_ROOT = Path(__file__).resolve().parent.parent.parent

# Logging
_handler = logging.FileHandler(str(LOG_FILE))
_handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S"))
log = logging.getLogger("hii.intent")
log.addHandler(_handler)
log.setLevel(logging.INFO)


class IntentType(str, Enum):
    HEAL = "heal"
    BUILD = "build"
    GROW = "grow"
    MAINTAIN = "maintain"
    CONNECT = "connect"
    REFLECT = "reflect"


@dataclass
class Intent:
    id: str
    type: str  # IntentType value
    description: str
    priority: int  # 1=critical, 5=low
    source: str  # observation, system_check, goal, schedule
    action: str  # restart_worker, register_skill, git_commit, etc.
    action_args: dict = field(default_factory=dict)
    status: str = "pending"  # pending, executing, completed, failed
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None
    result: Optional[str] = None


class IntentEngine:
    def __init__(self):
        self.intents: list[Intent] = []
        self.history: list[Intent] = []
        self.cycle_count: int = 0
        self._last_reflect: float = 0
        self._load_state()

    # ── Main Cycle ──────────────────────────────────────────────────────

    def cycle(self):
        """One full observe -> derive -> plan -> act -> reflect cycle."""
        self.cycle_count += 1
        log.info(f"cycle {self.cycle_count} starting")
        try:
            observations = self._observe()
            new_intents = self._derive(observations)
            if new_intents:
                log.info(f"derived {len(new_intents)} new intents")
            self.intents.extend(new_intents)
            self._prioritize()
            executed = self._act()
            if executed:
                log.info(f"executed {len(executed)} intents")
            self._reflect(executed)
            self._persist()
        except Exception as e:
            log.error(f"cycle {self.cycle_count} error: {e}")

    # ── Observe ─────────────────────────────────────────────────────────

    def _observe(self) -> dict:
        """Gather all system state into a dict of observations."""
        obs = {}

        # Daemon health
        try:
            from engine.core.daemon import is_running, PID_FILE
            running, pid = is_running()
            obs["daemon_running"] = running
            obs["daemon_pid"] = pid
            # Check for stale PID file
            if not running and PID_FILE.exists():
                obs["stale_pid"] = True
        except Exception as e:
            obs["daemon_running"] = None
            obs["daemon_error"] = str(e)

        # Git status
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=str(HII_ROOT), capture_output=True, text=True, timeout=10,
            )
            dirty_files = [l for l in result.stdout.strip().splitlines() if l.strip()]
            obs["git_dirty"] = len(dirty_files) > 0
            obs["git_dirty_count"] = len(dirty_files)
            obs["git_dirty_files"] = dirty_files[:20]  # cap for sanity
            # Check for .env in dirty
            obs["git_has_env"] = any(".env" in f for f in dirty_files)
        except Exception as e:
            obs["git_dirty"] = None
            obs["git_error"] = str(e)

        # Unpushed commits
        try:
            result = subprocess.run(
                ["git", "log", "--oneline", "@{u}..HEAD"],
                cwd=str(HII_ROOT), capture_output=True, text=True, timeout=10,
            )
            unpushed = [l for l in result.stdout.strip().splitlines() if l.strip()]
            obs["git_unpushed"] = len(unpushed)
        except Exception:
            obs["git_unpushed"] = 0

        # Task queue
        try:
            from engine.tasks.queue import list_tasks
            all_tasks = list_tasks()
            obs["tasks_total"] = len(all_tasks)
            obs["tasks_failed"] = len([t for t in all_tasks if t.status == "failed"])
            obs["tasks_queued"] = len([t for t in all_tasks if t.status == "queued"])
            obs["tasks_running"] = len([t for t in all_tasks if t.status == "running"])
            # Stale tasks: queued or running for >24h
            stale = []
            cutoff = (datetime.now() - timedelta(hours=24)).isoformat()
            for t in all_tasks:
                if t.status in ("queued", "running") and t.created_at < cutoff:
                    stale.append(t.id)
            obs["tasks_stale"] = stale
        except Exception as e:
            obs["tasks_error"] = str(e)

        # Workers (from workers.json)
        try:
            from engine.core.daemon import WORKERS_FILE
            if WORKERS_FILE.exists():
                specs = json.loads(WORKERS_FILE.read_text())
                obs["workers_configured"] = len(specs)
                obs["worker_ids"] = [s.get("id") for s in specs]
            else:
                obs["workers_configured"] = 0
        except Exception:
            obs["workers_configured"] = 0

        # Skills
        try:
            from engine.skills.registry import list_all
            skills = list_all()
            obs["skills_count"] = len(skills)
            obs["skills_categories"] = list({s.get("category", "") for s in skills})
        except Exception:
            obs["skills_count"] = 0

        # Psyche
        try:
            from engine.psyche.profile import PsycheProfile
            p = PsycheProfile.load()
            obs["psyche_loaded"] = True
            obs["psyche_name"] = p.name
            obs["observation_count"] = len(p.observations)
            obs["goal_count"] = len(p.goals)
            obs["active_goals"] = [g.description for g in p.goals if g.status == "active"][:10]
        except Exception as e:
            obs["psyche_loaded"] = False
            obs["psyche_error"] = str(e)

        # Log file sizes
        try:
            daemon_log = HII_DIR / "daemon.log"
            if daemon_log.exists():
                obs["daemon_log_size"] = daemon_log.stat().st_size
            else:
                obs["daemon_log_size"] = 0
        except Exception:
            obs["daemon_log_size"] = 0

        log.info(f"observed: daemon={obs.get('daemon_running')} git_dirty={obs.get('git_dirty_count', 0)} tasks_failed={obs.get('tasks_failed', 0)}")
        return obs

    # ── Derive ──────────────────────────────────────────────────────────

    def _derive(self, obs: dict) -> list[Intent]:
        """From observations, derive new intents."""
        intents = []
        existing_actions = {(i.action, json.dumps(i.action_args, sort_keys=True)) for i in self.intents}

        def _add(type_: str, desc: str, priority: int, source: str, action: str, args: dict = None):
            args = args or {}
            key = (action, json.dumps(args, sort_keys=True))
            if key not in existing_actions:
                intents.append(Intent(
                    id=uuid.uuid4().hex[:8],
                    type=type_,
                    description=desc,
                    priority=priority,
                    source=source,
                    action=action,
                    action_args=args,
                ))
                existing_actions.add(key)

        # ── HEAL ────────────────────────────────────────────────────────

        # Stale PID file
        if obs.get("stale_pid"):
            _add(IntentType.HEAL, "Clean stale daemon PID file",
                 1, "system_check", "clean_stale_pid")

        # Failed tasks
        if obs.get("tasks_failed", 0) > 0:
            _add(IntentType.HEAL, f"Retry or escalate {obs['tasks_failed']} failed tasks",
                 2, "system_check", "retry_failed_tasks")

        # Stale tasks
        for tid in obs.get("tasks_stale", []):
            _add(IntentType.HEAL, f"Prune stale task {tid} (>24h)",
                 3, "system_check", "prune_tasks", {"task_id": tid})

        # ── MAINTAIN ────────────────────────────────────────────────────

        # Git dirty (but no .env files)
        if obs.get("git_dirty") and not obs.get("git_has_env"):
            count = obs.get("git_dirty_count", 0)
            _add(IntentType.MAINTAIN, f"Auto-commit {count} dirty files",
                 4, "system_check", "git_commit",
                 {"file_count": count})

        # Git dirty with .env — warn only
        if obs.get("git_dirty") and obs.get("git_has_env"):
            _add(IntentType.MAINTAIN, "Git has uncommitted .env files — skipping auto-commit",
                 5, "system_check", "observe",
                 {"kind": "warning", "content": "Uncommitted .env files detected, manual commit needed"})

        # Archive logs if daemon.log > 1MB
        if obs.get("daemon_log_size", 0) > 1_000_000:
            _add(IntentType.MAINTAIN, "Rotate daemon.log (>1MB)",
                 4, "system_check", "archive_logs")

        # Prune completed tasks older than 48h
        if obs.get("tasks_total", 0) > 20:
            _add(IntentType.MAINTAIN, "Prune completed tasks",
                 5, "schedule", "prune_tasks")

        # ── BUILD ───────────────────────────────────────────────────────

        # Check if goals have matching skills
        for goal_desc in obs.get("active_goals", []):
            goal_lower = goal_desc.lower()
            categories = obs.get("skills_categories", [])
            # Simple heuristic: if goal mentions something and no skill category matches
            keywords = ["api", "deploy", "test", "monitor", "backup", "sync"]
            for kw in keywords:
                if kw in goal_lower and kw not in " ".join(categories).lower():
                    _add(IntentType.BUILD, f"Goal needs capability: {goal_desc[:60]}",
                         3, "goal", "create_task",
                         {"name": f"Build skill for: {goal_desc[:60]}", "target": "architect",
                          "prompt": f"Create a skill to address goal: {goal_desc}"})
                    break

        # ── GROW ────────────────────────────────────────────────────────

        # If very few observations, note that
        if obs.get("observation_count", 0) < 5 and obs.get("psyche_loaded"):
            _add(IntentType.GROW, "Low observation count — system needs more context",
                 4, "system_check", "observe",
                 {"kind": "system", "content": "Intent engine notes low observation count. More interaction data will improve intent derivation."})

        # ── REFLECT ─────────────────────────────────────────────────────

        # Every 10 cycles, summarize
        if self.cycle_count > 0 and self.cycle_count % 10 == 0:
            recent = self.history[-20:]
            completed = len([i for i in recent if i.status == "completed"])
            failed = len([i for i in recent if i.status == "failed"])
            _add(IntentType.REFLECT,
                 f"Cycle {self.cycle_count} summary: {completed} completed, {failed} failed in last 20",
                 5, "schedule", "observe",
                 {"kind": "intent_summary",
                  "content": f"Intent engine cycle {self.cycle_count}: {completed} completed, {failed} failed in last 20 intents"})

        return intents

    # ── Prioritize ──────────────────────────────────────────────────────

    def _prioritize(self):
        """Sort by priority, dedup."""
        seen = set()
        deduped = []
        for intent in self.intents:
            key = (intent.action, json.dumps(intent.action_args, sort_keys=True))
            if key not in seen:
                seen.add(key)
                deduped.append(intent)
        deduped.sort(key=lambda i: i.priority)
        self.intents = deduped

    # ── Act ─────────────────────────────────────────────────────────────

    def _act(self) -> list[Intent]:
        """Execute up to 3 top-priority intents."""
        executed = []
        remaining = []

        for intent in self.intents:
            if len(executed) >= 3:
                remaining.append(intent)
                continue

            intent.status = "executing"
            handler = self._action_handlers.get(intent.action)
            if handler is None:
                intent.status = "failed"
                intent.result = f"no handler for action '{intent.action}'"
                intent.completed_at = datetime.now().isoformat()
                log.warning(f"no handler for action={intent.action}")
                self.history.append(intent)
                executed.append(intent)
                continue

            try:
                result = handler(self, intent)
                intent.status = "completed"
                intent.result = str(result) if result else "ok"
                log.info(f"intent {intent.id} completed: {intent.action}")
            except Exception as e:
                intent.status = "failed"
                intent.result = str(e)
                log.error(f"intent {intent.id} failed: {intent.action} — {e}")

            intent.completed_at = datetime.now().isoformat()
            self.history.append(intent)
            executed.append(intent)

        self.intents = remaining
        return executed

    # ── Reflect ─────────────────────────────────────────────────────────

    def _reflect(self, executed: list[Intent]):
        """Write observations about what was done."""
        if not executed:
            return
        try:
            from engine.psyche.profile import PsycheProfile
            p = PsycheProfile.load()
            for intent in executed:
                content = f"intent_engine {intent.type} [{intent.status}]: {intent.description}"
                if intent.result and intent.result != "ok":
                    content += f" — {intent.result[:200]}"
                p.observe("intent_action", content, "intent_engine")
        except Exception as e:
            log.error(f"reflect error: {e}")

    # ── Persist ─────────────────────────────────────────────────────────

    def _persist(self):
        """Save state to disk."""
        # Keep history bounded
        if len(self.history) > 200:
            self.history = self.history[-200:]

        state = {
            "cycle_count": self.cycle_count,
            "intents": [asdict(i) for i in self.intents],
            "history": [asdict(i) for i in self.history],
        }
        try:
            STATE_FILE.write_text(json.dumps(state, indent=2))
        except Exception as e:
            log.error(f"persist error: {e}")

    def _load_state(self):
        """Load state from disk."""
        if not STATE_FILE.exists():
            return
        try:
            raw = json.loads(STATE_FILE.read_text())
            self.cycle_count = raw.get("cycle_count", 0)
            self.intents = [Intent(**i) for i in raw.get("intents", [])]
            self.history = [Intent(**i) for i in raw.get("history", [])]
        except Exception as e:
            log.error(f"load_state error: {e}")

    # ── Action Handlers ─────────────────────────────────────────────────

    def _action_clean_stale_pid(self, intent: Intent) -> str:
        from engine.core.daemon import PID_FILE
        try:
            PID_FILE.unlink(missing_ok=True)
            return "removed stale PID file"
        except Exception as e:
            return f"failed to remove PID: {e}"

    def _action_restart_daemon(self, intent: Intent) -> str:
        from engine.core.daemon import start_background
        pid = start_background()
        return f"daemon started pid={pid}"

    def _action_restart_worker(self, intent: Intent) -> str:
        worker_id = intent.action_args.get("worker_id", "")
        # Write a command file the daemon can pick up
        cmd_file = HII_DIR / "daemon_cmd.json"
        cmd_file.write_text(json.dumps({"action": "restart_worker", "worker_id": worker_id}))
        return f"requested restart of worker {worker_id}"

    def _action_git_commit(self, intent: Intent) -> str:
        # Safety: never commit .env files
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(HII_ROOT), capture_output=True, text=True, timeout=10,
        )
        dirty = result.stdout.strip().splitlines()
        # Filter out .env and credentials
        unsafe = [f for f in dirty if any(pat in f for pat in [".env", "credentials", "secret", ".pem", ".key"])]
        if unsafe:
            return f"skipped: unsafe files detected ({len(unsafe)} files)"

        # Stage and commit
        subprocess.run(
            ["git", "add", "-A"],
            cwd=str(HII_ROOT), capture_output=True, timeout=10,
        )
        msg = f"auto: intent engine maintenance ({len(dirty)} files)"
        result = subprocess.run(
            ["git", "commit", "-m", msg],
            cwd=str(HII_ROOT), capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return f"committed: {msg}"
        return f"git commit returned {result.returncode}: {result.stderr[:200]}"

    def _action_register_skill(self, intent: Intent) -> str:
        from engine.skills.registry import Skill, register
        args = intent.action_args
        skill = Skill(
            id=args.get("id", uuid.uuid4().hex[:8]),
            name=args.get("name", "unnamed"),
            description=args.get("description", ""),
            category=args.get("category", "auto"),
            target=args.get("target", "local"),
            inputs=args.get("inputs", {}),
            script=args.get("script"),
            template=args.get("template"),
        )
        path = register(skill)
        return f"registered skill {skill.id} at {path}"

    def _action_create_task(self, intent: Intent) -> str:
        from engine.tasks.queue import add as add_task
        args = intent.action_args
        task = add_task(
            name=args.get("name", intent.description),
            target=args.get("target", "architect"),
            script=args.get("script"),
            prompt=args.get("prompt"),
        )
        return f"created task {task.id}: {task.name}"

    def _action_search_api(self, intent: Intent) -> str:
        try:
            from engine.tools.api_registry import search_catalog
            query = intent.action_args.get("query", "")
            results = search_catalog(query, limit=5)
            names = [e.name for _, e in results]
            return f"found {len(results)} APIs: {', '.join(names)}"
        except Exception as e:
            return f"api search failed: {e}"

    def _action_observe(self, intent: Intent) -> str:
        from engine.psyche.profile import PsycheProfile
        p = PsycheProfile.load()
        kind = intent.action_args.get("kind", "observation")
        content = intent.action_args.get("content", intent.description)
        p.observe(kind, content, "intent_engine")
        return f"observed: {kind}"

    def _action_prune_tasks(self, intent: Intent) -> str:
        from engine.tasks.queue import list_tasks, _load, _save
        tasks = _load()
        cutoff = (datetime.now() - timedelta(hours=48)).isoformat()
        before = len(tasks)
        tasks = [t for t in tasks if not (
            t.get("status") in ("done", "failed") and
            (t.get("completed_at") or t.get("created_at", "")) < cutoff
        )]
        # Also prune specific stale task if requested
        tid = intent.action_args.get("task_id")
        if tid:
            tasks = [t for t in tasks if t.get("id") != tid]
        _save(tasks)
        pruned = before - len(tasks)
        return f"pruned {pruned} tasks"

    def _action_archive_logs(self, intent: Intent) -> str:
        daemon_log = HII_DIR / "daemon.log"
        if not daemon_log.exists():
            return "no daemon.log to archive"
        size = daemon_log.stat().st_size
        if size <= 1_000_000:
            return f"daemon.log only {size} bytes, skipping"
        archive = HII_DIR / f"daemon.log.{datetime.now().strftime('%Y%m%d%H%M%S')}"
        daemon_log.rename(archive)
        daemon_log.touch()
        return f"archived {size} bytes to {archive.name}"

    def _action_retry_failed_tasks(self, intent: Intent) -> str:
        from engine.tasks.queue import _load, _save
        tasks = _load()
        retried = 0
        for t in tasks:
            if t.get("status") == "failed":
                retries = t.get("retries", 0)
                max_r = t.get("max_retries", 2)
                if retries < max_r + 1:  # give one extra chance
                    t["status"] = "queued"
                    t["retries"] = retries  # keep count
                    retried += 1
        _save(tasks)
        return f"re-queued {retried} failed tasks"

    # Handler dispatch table
    _action_handlers = {
        "clean_stale_pid": _action_clean_stale_pid,
        "restart_daemon": _action_restart_daemon,
        "restart_worker": _action_restart_worker,
        "git_commit": _action_git_commit,
        "register_skill": _action_register_skill,
        "create_task": _action_create_task,
        "search_api": _action_search_api,
        "observe": _action_observe,
        "prune_tasks": _action_prune_tasks,
        "archive_logs": _action_archive_logs,
        "retry_failed_tasks": _action_retry_failed_tasks,
    }


# ── CLI ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "cycle"

    if cmd == "cycle":
        engine = IntentEngine()
        engine.cycle()
        print(f"cycle {engine.cycle_count} complete — {len(engine.intents)} pending, {len(engine.history)} in history")

    elif cmd == "loop":
        engine = IntentEngine()
        interval = int(os.environ.get("HII_INTENT_INTERVAL", "60"))
        print(f"intent loop started (interval={interval}s)")
        try:
            while True:
                engine.cycle()
                print(f"  cycle {engine.cycle_count}: {len(engine.intents)} pending, {len(engine.history)} history")
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nstopped")

    elif cmd == "status":
        engine = IntentEngine()
        # Already loaded in __init__
        print(f"cycles: {engine.cycle_count}")
        print(f"pending intents: {len(engine.intents)}")
        if engine.intents:
            print("  --- pending ---")
            for i in engine.intents[:10]:
                print(f"  [{i.priority}] {i.type} {i.action}: {i.description}")
        recent = engine.history[-10:]
        if recent:
            print(f"  --- recent history ({len(engine.history)} total) ---")
            for i in recent:
                print(f"  [{i.status}] {i.type} {i.action}: {i.description}")

    else:
        print(f"unknown command: {cmd}")
        print("usage: python3 -m engine.core.intent [cycle|loop|status]")
        sys.exit(1)
