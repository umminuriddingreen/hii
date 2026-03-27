#!/usr/bin/env python3
"""
HII Dashboard Server

The translation layer between what HII is thinking, what it knows,
what we've done together, and what there is to do.

Exposes:
    GET  /              — dashboard UI
    GET  /api/state     — full system state (psyche, tasks, agents, skills, version)
    GET  /api/psyche    — psyche profile + system prompt
    GET  /api/tasks     — task queue
    GET  /api/skills    — skill registry index
    GET  /api/agents    — registered agents
    GET  /api/version   — version/git state
    GET  /api/logs      — daemon logs
    GET  /api/health    — health check
    POST /api/task      — add a task
    POST /api/observe   — add psyche observation
"""

import json
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

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
PORT = int(os.environ.get("HII_PORT", "8888"))


class HiiHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "" or path == "/":
            return self._serve_file("index.html", "text/html")
        elif path == "/api/state":
            return self._json(self._full_state())
        elif path == "/api/psyche":
            p = PsycheProfile.load()
            return self._json({"profile": p.summary(), "system_prompt": p.to_system_prompt()})
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
        elif path.startswith("/static/"):
            fname = path[8:]  # strip /static/
            return self._serve_file(fname)
        else:
            self.send_error(404)

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
        else:
            self.send_error(404)

    def _full_state(self) -> dict:
        p = PsycheProfile.load()
        running, pid = is_running()
        tasks = list_tasks()
        return {
            "psyche": p.summary(),
            "system_prompt": p.to_system_prompt(),
            "tasks": [{"id": t.id, "name": t.name, "target": t.target, "status": t.status} for t in tasks],
            "skills_count": len(skills_list()),
            "skills_categories": list(set(s["category"] for s in skills_list())),
            "agents": [{"id": a.id, "name": a.name, "type": a.agent_type, "active": a.active} for a in list_agents(active_only=False)],
            "version": version_current(),
            "history": version_log(10),
            "daemon": {"running": running, "pid": pid},
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


def main():
    port = PORT
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
