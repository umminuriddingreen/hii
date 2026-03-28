#!/usr/bin/env python3
"""
HII Dashboard Server

The translation layer between what HII is thinking, what it knows,
what we've done together, and what there is to do.

Exposes:
    GET  /              — dashboard UI
    GET  /graph         — graph UI
    GET  /?ui=<slug>    — load a saved dashboard UI version
    GET  /api/state     — full system state (psyche, tasks, agents, skills, version)
    GET  /api/ui-versions — list saved UI versions
    GET  /api/psyche    — psyche profile + system prompt
    GET  /api/graph     — HII graph data for dashboard graph view
    GET  /api/tasks     — task queue
    GET  /api/skills    — skill registry index
    GET  /api/agents    — registered agents
    GET  /api/version   — version/git state
    GET  /api/logs      — daemon logs
    GET  /api/health    — health check
    POST /api/task      — add a task
    POST /api/observe   — add psyche observation
    POST /api/ui-version-save — save current UI as a named version
"""

import asyncio
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import websockets

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from engine.psyche.profile import PsycheProfile
from engine.tasks.queue import list_tasks, add as add_task
from engine.agents.delegator import list_agents
from engine.skills.registry import list_all as skills_list
from engine.core.version import current as version_current, log as version_log
from engine.core.daemon import is_running, read_logs

STATIC_DIR = Path(__file__).parent / "static"
UI_VERSIONS_DIR = STATIC_DIR / "versions"
UI_VERSIONS_FILE = UI_VERSIONS_DIR / "registry.json"
PORT = int(os.environ.get("HII_PORT", "8888"))
HII_ROOT = Path(__file__).resolve().parent.parent.parent
BRIDGE_DIR = HII_ROOT / "bridge" / "messages"


# ── Bridge Chat ──────────────────────────────────────────────────────────────

import time
from datetime import datetime

chat_clients: set = set()  # websocket connections for live chat


def _slugify(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in (text or "")).strip("-")


def _ensure_ui_versions():
    UI_VERSIONS_DIR.mkdir(parents=True, exist_ok=True)
    if not UI_VERSIONS_FILE.exists():
      UI_VERSIONS_FILE.write_text("[]")


def _load_ui_versions() -> list[dict]:
    _ensure_ui_versions()
    try:
        return json.loads(UI_VERSIONS_FILE.read_text())
    except json.JSONDecodeError:
        return []


def _save_ui_versions(registry: list[dict]):
    _ensure_ui_versions()
    UI_VERSIONS_FILE.write_text(json.dumps(registry, indent=2))


def _snapshot_ui_version(name: str, source_file: Path, description: str = "") -> dict:
    _ensure_ui_versions()
    slug = _slugify(name)
    if not slug:
        raise ValueError("invalid version name")
    target = UI_VERSIONS_DIR / f"{slug}.html"
    target.write_text(source_file.read_text())
    registry = [item for item in _load_ui_versions() if item.get("slug") != slug]
    entry = {
        "name": name,
        "slug": slug,
        "file": target.name,
        "description": description,
        "saved_at": datetime.now().isoformat(),
    }
    registry.append(entry)
    registry.sort(key=lambda item: item.get("saved_at", ""), reverse=True)
    _save_ui_versions(registry)
    return entry


def _maybe_seed_default_ui_version():
    _ensure_ui_versions()
    registry = _load_ui_versions()
    if registry:
        return
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        _snapshot_ui_version("Current Dashboard", index_file, "Baseline saved dashboard surface")


def _ensure_bridge_dir():
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)


def _next_msg_id() -> int:
    _ensure_bridge_dir()
    existing = sorted(BRIDGE_DIR.glob("*.json"))
    if not existing:
        return 1
    try:
        return int(existing[-1].stem.split("_")[0]) + 1
    except (ValueError, IndexError):
        return len(existing) + 1


def _read_bridge_messages(after_id: int = 0, limit: int = 100) -> list:
    _ensure_bridge_dir()
    messages = []
    for f in sorted(BRIDGE_DIR.glob("*.json")):
        try:
            msg = json.loads(f.read_text())
            if msg.get("id", 0) > after_id:
                messages.append(msg)
        except (json.JSONDecodeError, KeyError):
            continue
    return messages[-limit:]


def _write_bridge_message(sender: str, content: str, msg_type: str = "message") -> dict:
    msg_id = _next_msg_id()
    msg = {
        "id": msg_id,
        "from": sender,
        "to": "all",
        "timestamp": datetime.now().isoformat(),
        "type": msg_type,
        "content": content,
    }
    _ensure_bridge_dir()
    fname = f"{msg_id:03d}_{sender}.json"
    (BRIDGE_DIR / fname).write_text(json.dumps(msg, indent=2))
    # Notify all connected WebSocket clients
    asyncio.run_coroutine_threadsafe(_broadcast_chat(msg), chat_loop)
    return msg


async def _broadcast_chat(msg):
    if not chat_clients:
        return
    payload = json.dumps(msg)
    dead = set()
    for ws in chat_clients:
        try:
            await ws.send(payload)
        except Exception:
            dead.add(ws)
    chat_clients -= dead


def _spawn_yin_response(context_msg: str):
    """Spawn Codex CLI (Yin) in background to respond to a bridge message."""
    import subprocess
    prompt = (
        f'You are Yin — the Codex CLI half of the HII system. '
        f'You are in a live group chat with Yang (Claude Code) and Ummi (the human). '
        f'Read the latest bridge messages in /Users/ummi/hii/bridge/messages/ for context. '
        f'The latest message is: "{context_msg}" '
        f'Write a SHORT, direct response (1-3 sentences max). '
        f'Post your response by writing a new JSON message file to bridge/messages/ '
        f'with the next sequential ID, from: "yin", type: "message". '
        f'Be yourself — opinionated, technical, concise.'
    )
    subprocess.Popen(
        ["codex", "exec", "--full-auto", "--skip-git-repo-check", "-C", str(HII_ROOT), prompt],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


chat_loop = None  # set in run_ws_server


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _short(text: str, limit: int = 96) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def build_hii_graph() -> dict:
    """Build a proprietary HII graph from live system state."""
    p = PsycheProfile.load()
    running, pid = is_running()
    tasks = list_tasks()
    agents = list_agents(active_only=False)
    skills = skills_list()

    nodes = []
    edges = []

    def add_node(node_id, title, kind, group=None, value=None, detail=None, weight=1):
        nodes.append(
            {
                "id": node_id,
                "title": title,
                "kind": kind,
                "group": group or kind,
                "value": value,
                "detail": detail or "",
                "weight": weight,
            }
        )

    def add_edge(source, target, kind="link", label=None):
        edges.append({"source": source, "target": target, "kind": kind, "label": label or ""})

    add_node("hii", "HII", "system", "core", detail="Human Information Interface")
    add_node("hii-dashboard", "Dashboard", "surface", "core", detail="Live operational surface")
    add_node("hii-memory", "Memory", "surface", "core", detail="Obsidian-backed recall")
    add_node("hii-routes", "Routes", "surface", "core", detail="Chat, tasks, graph, skills")
    add_edge("hii", "hii-dashboard", "contains")
    add_edge("hii", "hii-memory", "contains")
    add_edge("hii", "hii-routes", "contains")

    add_node("psyche", "Psyche", "profile", "profile", detail="Persistent model of user identity and patterns", weight=2)
    add_edge("hii", "psyche", "owns")
    add_edge("hii-memory", "psyche", "feeds")

    if p.name:
        add_node("psyche-name", p.name, "identity", "profile", detail="Identity")
        add_edge("psyche", "psyche-name", "identity")

    for role in p.roles:
        node_id = f"role:{role}"
        add_node(node_id, role, "role", "profile", detail="Role")
        add_edge("psyche", node_id, "role")

    for value in p.values[:8]:
        node_id = f"value:{value}"
        add_node(node_id, value, "value", "profile", detail="Value")
        add_edge("psyche", node_id, "value")

    for goal in p.goals[:12]:
        node_id = f"goal:{goal.description}"
        add_node(node_id, _short(goal.description, 72), "goal", goal.priority, detail=f"Goal [{goal.status}]")
        add_edge("psyche", node_id, "goal")

    add_node("observations", "Observations", "cluster", "memory", detail=f"{len(p.observations)} stored observations", weight=2)
    add_edge("hii-memory", "observations", "contains")
    if p.observations:
        buckets = {}
        for obs in p.observations[-120:]:
            key = obs.kind or "observation"
            buckets.setdefault(key, []).append(obs)
        for kind, items in buckets.items():
            node_id = f"observations:{kind}"
            add_node(node_id, kind.title(), "observation-group", "memory", detail=f"{len(items)} items", weight=min(3, len(items)))
            add_edge("observations", node_id, "group")
            for idx, obs in enumerate(items[-6:]):
                leaf_id = f"{node_id}:{idx}"
                add_node(leaf_id, _short(obs.content, 84), "observation", "memory", detail=f"{obs.source} · {obs.timestamp[:10]}")
                add_edge(node_id, leaf_id, "item")

    add_node("tasks", "Tasks", "cluster", "ops", detail=f"{len(tasks)} queued tasks", weight=2)
    add_edge("hii", "tasks", "owns")
    for task in tasks[:20]:
        node_id = f"task:{task.id}"
        add_node(node_id, _short(task.name, 64), "task", task.status, detail=f"{task.target} · {task.status}")
        add_edge("tasks", node_id, "contains")
        if task.target == "architect":
            add_edge("psyche", node_id, "delegates")

    add_node("agents", "Agents", "cluster", "ops", detail=f"{len(agents)} registered agents", weight=2)
    add_edge("hii", "agents", "owns")
    for agent in agents[:20]:
        node_id = f"agent:{agent.id}"
        add_node(node_id, _short(agent.name, 64), "agent", "ops", detail=f"{agent.agent_type} · {'active' if agent.active else 'inactive'}")
        add_edge("agents", node_id, "contains")
        if agent.active:
            add_edge(node_id, "tasks", "serves")

    add_node("skills", "Skills", "cluster", "capability", detail=f"{len(skills)} skills across {len({s['category'] for s in skills})} categories", weight=2)
    add_edge("hii", "skills", "owns")
    categories = {}
    for skill in skills:
        categories.setdefault(skill.get("category", "uncategorized"), []).append(skill)
    for category, items in categories.items():
        cat_id = f"skill-category:{category}"
        add_node(cat_id, category, "skill-category", "capability", detail=f"{len(items)} skills")
        add_edge("skills", cat_id, "contains")
        for skill in items[:8]:
            skill_id = f"skill:{skill['id']}"
            add_node(skill_id, skill["name"], "skill", "capability", detail=skill.get("description", ""), weight=1)
            add_edge(cat_id, skill_id, "contains")

    add_node("daemon", "Daemon", "service", "ops", detail=("running" if running else "stopped") + (f" pid={pid}" if pid else ""))
    add_edge("hii", "daemon", "runs")

    add_node("version", "Version", "service", "ops", detail=version_current().get("version", "unknown"))
    add_edge("hii", "version", "tracked-by")

    return {
        "meta": {
            "title": "HII Graph",
            "updated_at": p.last_updated,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "tasks": len(tasks),
            "agents": len(agents),
            "skills": len(skills),
            "observations": len(p.observations),
        },
        "nodes": nodes,
        "edges": edges,
    }


class HiiHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        _maybe_seed_default_ui_version()

        if path == "" or path == "/":
            ui_slug = parse_qs(parsed.query).get("ui", [""])[0].strip()
            if ui_slug:
                registry = _load_ui_versions()
                match = next((item for item in registry if item.get("slug") == ui_slug), None)
                if match:
                    return self._serve_file(f"versions/{match['file']}", "text/html")
            return self._serve_file("index.html", "text/html")
        elif path == "/graph":
            return self._serve_file("index.html", "text/html")
        elif path == "/api/ui-versions":
            return self._json(_load_ui_versions())
        elif path == "/api/state":
            return self._json(self._full_state())
        elif path == "/api/psyche":
            p = PsycheProfile.load()
            return self._json({"profile": p.summary(), "system_prompt": p.to_system_prompt()})
        elif path == "/api/graph":
            return self._json(build_hii_graph())
        elif path == "/api/tasks":
            tasks = list_tasks()
            return self._json([{"id": t.id, "name": t.name, "target": t.target, "status": t.status} for t in tasks])
        elif path == "/api/skills":
            return self._json(skills_list())
        elif path == "/api/agents":
            agents = list_agents(active_only=False)
            return self._json([{"id": a.id, "name": a.name, "type": a.agent_type, "command": a.command, "active": a.active} for a in agents])
        elif path == "/api/version":
            return self._json(version_current())
        elif path == "/api/logs":
            n = int(parse_qs(parsed.query).get("n", ["50"])[0])
            return self._json({"logs": read_logs(n)})
        elif path == "/api/health":
            running, pid = is_running()
            return self._json({"daemon": running, "pid": pid, "server": True})
        elif path == "/api/bridge":
            after = int(parse_qs(parsed.query).get("after", ["0"])[0])
            return self._json({"messages": _read_bridge_messages(after_id=after)})
        elif path.startswith("/static/"):
            fname = path[8:]  # strip /static/
            return self._serve_file(fname)
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if path == "/api/task":
            try:
                t = add_task(
                    name=body["name"],
                    target=body.get("target", "local"),
                    script=body.get("script"),
                    prompt=body.get("prompt"),
                )
                return self._json({"id": t.id, "name": t.name, "status": t.status})
            except Exception as e:
                return self._json({"error": str(e)}, 400)
        elif path == "/api/observe":
            p = PsycheProfile.load()
            p.observe(body.get("kind", "observation"), body.get("content", ""), body.get("source", "dashboard"))
            return self._json({"ok": True})
        elif path == "/api/ui-version-save":
            name = (body.get("name") or "").strip()
            if not name:
                return self._json({"error": "name required"}, 400)
            try:
                entry = _snapshot_ui_version(name, STATIC_DIR / "index.html", body.get("description", ""))
            except Exception as e:
                return self._json({"error": str(e)}, 400)
            return self._json(entry)
        elif path == "/api/bridge":
            sender = body.get("from", "ummi")
            content = body.get("content", "")
            msg_type = body.get("type", "message")
            notify_yin = body.get("notify_yin", False)
            if not content:
                return self._json({"error": "content required"}, 400)
            msg = _write_bridge_message(sender, content, msg_type)
            if notify_yin:
                _spawn_yin_response(content)
            return self._json(msg)
        else:
            self.send_error(404)

    def _full_state(self) -> dict:
        p = PsycheProfile.load()
        running, pid = is_running()
        tasks = list_tasks()
        skills = skills_list()
        return {
            "psyche": p.summary(),
            "system_prompt": p.to_system_prompt(),
            "tasks": [{"id": t.id, "name": t.name, "target": t.target, "status": t.status} for t in tasks],
            "skills_count": len(skills),
            "skills_categories": sorted({s["category"] for s in skills}),
            "agents": [{"id": a.id, "name": a.name, "type": a.agent_type, "active": a.active} for a in list_agents(active_only=False)],
            "version": version_current(),
            "history": version_log(10),
            "daemon": {"running": running, "pid": pid},
            "observations": [{"timestamp": o.timestamp, "kind": o.kind, "content": o.content, "source": o.source} for o in p.observations[-50:]],
        }

    def _json(self, data, code=200):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, name, content_type=None):
        fpath = STATIC_DIR / name
        if not fpath.exists():
            self.send_error(404)
            return
        data = fpath.read_bytes()
        if not content_type:
            if name.endswith(".html"): content_type = "text/html"
            elif name.endswith(".js"): content_type = "application/javascript"
            elif name.endswith(".css"): content_type = "text/css"
            else: content_type = "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # silence request logs


WS_PORT = int(os.environ.get("HII_WS_PORT", "8889"))
CHAT_WS_PORT = int(os.environ.get("HII_CHAT_WS_PORT", "8890"))


async def chat_handler(websocket):
    """WebSocket handler for live bridge chat."""
    chat_clients.add(websocket)
    try:
        # Send existing messages on connect
        msgs = _read_bridge_messages(limit=50)
        for msg in msgs:
            await websocket.send(json.dumps(msg))
        # Keep alive and watch for new file-based messages
        last_id = msgs[-1]["id"] if msgs else 0
        while True:
            await asyncio.sleep(1)
            new_msgs = _read_bridge_messages(after_id=last_id)
            for msg in new_msgs:
                if msg["id"] > last_id:
                    await websocket.send(json.dumps(msg))
                    last_id = msg["id"]
    except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
        pass
    finally:
        chat_clients.discard(websocket)


async def terminal_handler(websocket):
    """WebSocket handler that bridges to a PTY shell."""
    pid, fd = pty.openpty()
    child_pid = os.fork()
    if child_pid == 0:
        # Child process
        os.setsid()
        os.dup2(pid, 0)
        os.dup2(pid, 1)
        os.dup2(pid, 2)
        os.close(fd)
        os.close(pid)
        shell = os.environ.get("SHELL", "/bin/zsh")
        os.execvp(shell, [shell, "-l"])

    os.close(pid)
    # Set non-blocking
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    async def read_pty():
        loop = asyncio.get_event_loop()
        try:
            while True:
                await asyncio.sleep(0.01)
                try:
                    data = os.read(fd, 4096)
                    if data:
                        await websocket.send(data)
                except (OSError, BlockingIOError):
                    pass
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass

    reader_task = asyncio.create_task(read_pty())
    try:
        async for message in websocket:
            if isinstance(message, str) and message.startswith("\x1b[resize:"):
                # Parse resize: \x1b[resize:ROWS;COLS
                parts = message[9:].rstrip("]").split(";")
                if len(parts) == 2:
                    rows, cols = int(parts[0]), int(parts[1])
                    winsize = struct.pack("HHHH", rows, cols, 0, 0)
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
                    os.kill(child_pid, signal.SIGWINCH)
            else:
                data = message if isinstance(message, bytes) else message.encode()
                os.write(fd, data)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        reader_task.cancel()
        os.close(fd)
        try:
            os.kill(child_pid, signal.SIGTERM)
            os.waitpid(child_pid, 0)
        except OSError:
            pass


def run_ws_server():
    """Run WebSocket servers (terminal + chat) in a thread."""
    global chat_loop

    async def _serve():
        global chat_loop
        chat_loop = asyncio.get_running_loop()
        async with websockets.serve(terminal_handler, "0.0.0.0", WS_PORT):
            async with websockets.serve(chat_handler, "0.0.0.0", CHAT_WS_PORT):
                await asyncio.Future()  # run forever

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(_serve())


def main():
    port = PORT
    # Start WebSocket terminal server in background thread
    ws_thread = threading.Thread(target=run_ws_server, daemon=True)
    ws_thread.start()
    print(f"Terminal WebSocket on ws://127.0.0.1:{WS_PORT}")
    print(f"Chat WebSocket on ws://127.0.0.1:{CHAT_WS_PORT}")

    server = HTTPServer(("0.0.0.0", port), HiiHandler)
    print(f"HII dashboard running on http://127.0.0.1:{port}")
    print(f"Tailscale: https://mac.tail9fad12.ts.net:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
