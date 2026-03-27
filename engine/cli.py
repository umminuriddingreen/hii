#!/usr/bin/env python3
"""
HII Engine CLI — Interface to the persistence engine.

Usage:
    python -m engine.cli daemon start|stop|status|logs
    python -m engine.cli psyche show|init|export
    python -m engine.cli task add|list|run|purge
    python -m engine.cli agent register|list|run|deactivate
"""

import sys
import json
import argparse

from .core.daemon import is_running, read_logs
from .psyche.profile import PsycheProfile
from .tasks.queue import add as add_task, list_tasks, claim_next, complete, purge_done, Target
from .agents.delegator import register as register_agent, list_agents, run as run_agent, deactivate


def main():
    parser = argparse.ArgumentParser(prog="hii-engine", description="HII Persistence Engine")
    sub = parser.add_subparsers(dest="command")

    # ── daemon ──
    daemon_p = sub.add_parser("daemon")
    daemon_p.add_argument("action", choices=["start", "stop", "status", "logs"])
    daemon_p.add_argument("-n", "--lines", type=int, default=50)

    # ── psyche ──
    psyche_p = sub.add_parser("psyche")
    psyche_p.add_argument("action", choices=["show", "init", "export", "summary"])
    psyche_p.add_argument("--name", default=None)
    psyche_p.add_argument("--roles", nargs="*", default=None)
    psyche_p.add_argument("--domains", nargs="*", default=None)
    psyche_p.add_argument("--values", nargs="*", default=None)

    # ── task ──
    task_p = sub.add_parser("task")
    task_p.add_argument("action", choices=["add", "list", "run", "purge"])
    task_p.add_argument("--name", default=None)
    task_p.add_argument("--target", choices=["local", "architect"], default="local")
    task_p.add_argument("--script", default=None)
    task_p.add_argument("--prompt", default=None)
    task_p.add_argument("--status", default=None)

    # ── agent ──
    agent_p = sub.add_parser("agent")
    agent_p.add_argument("action", choices=["register", "list", "run", "deactivate"])
    agent_p.add_argument("--name", default=None)
    agent_p.add_argument("--type", choices=["runner", "watcher", "syncer"], default="runner")
    agent_p.add_argument("--command", default=None)
    agent_p.add_argument("--id", default=None)

    args = parser.parse_args()

    if args.command == "daemon":
        if args.action == "status":
            running, pid = is_running()
            print(f"{'running' if running else 'stopped'}" + (f" pid={pid}" if pid else ""))
        elif args.action == "logs":
            print(read_logs(args.lines))
        elif args.action in ("start", "stop"):
            import subprocess
            subprocess.run([sys.executable, "-m", "engine.core.daemon", args.action])

    elif args.command == "psyche":
        p = PsycheProfile.load()
        if args.action == "init":
            if args.name: p.name = args.name
            if args.roles: p.roles = args.roles
            if args.domains: p.domains = args.domains
            if args.values: p.values = args.values
            p.save()
            print(f"Psyche initialized: {p.name}")
        elif args.action == "show":
            print(json.dumps(p.summary(), indent=2))
        elif args.action == "export":
            print(p.to_system_prompt())
        elif args.action == "summary":
            print(p.to_system_prompt())

    elif args.command == "task":
        if args.action == "add":
            if not args.name:
                print("--name required"); sys.exit(1)
            t = add_task(args.name, args.target, script=args.script, prompt=args.prompt)
            print(f"Task {t.id}: {t.name} -> {t.target}")
        elif args.action == "list":
            tasks = list_tasks(status=args.status, target=args.target if args.target != "local" else None)
            for t in tasks:
                print(f"  [{t.status}] {t.id} {t.name} -> {t.target}")
        elif args.action == "purge":
            n = purge_done()
            print(f"Purged {n} completed tasks")

    elif args.command == "agent":
        if args.action == "register":
            if not args.name or not args.command:
                print("--name and --command required"); sys.exit(1)
            a = register_agent(args.name, args.type, args.command)
            print(f"Agent {a.id}: {a.name} ({a.agent_type})")
        elif args.action == "list":
            for a in list_agents(args.type if args.type != "runner" else None):
                print(f"  [{a.agent_type}] {a.id} {a.name}: {a.command}")
        elif args.action == "run":
            agents = list_agents()
            target = next((a for a in agents if a.id == args.id), None)
            if not target:
                print(f"Agent {args.id} not found"); sys.exit(1)
            result = run_agent(target)
            print(f"exit={result.exit_code}\n{result.stdout}")
            if result.stderr:
                print(f"stderr: {result.stderr}")
        elif args.action == "deactivate":
            if not args.id:
                print("--id required"); sys.exit(1)
            deactivate(args.id)
            print(f"Deactivated {args.id}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
