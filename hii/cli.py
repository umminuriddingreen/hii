"""HII unified CLI."""

from __future__ import annotations
import sys
import json
from pathlib import Path

import click

from . import __version__

HII_ROOT = Path(__file__).resolve().parent.parent


@click.group()
@click.version_option(__version__)
def main():
    """HII — Human Information Interface"""
    pass


# ── daemon ──

@main.group()
def daemon():
    """Manage the HII daemon."""
    pass

@daemon.command()
def start():
    """Start the daemon."""
    import subprocess
    subprocess.run([sys.executable, "-m", "hii.core.daemon", "start"], cwd=HII_ROOT)

@daemon.command()
def stop():
    """Stop the daemon."""
    import subprocess
    subprocess.run([sys.executable, "-m", "hii.core.daemon", "stop"], cwd=HII_ROOT)

@daemon.command()
def status():
    """Show daemon status."""
    from .core.daemon import is_running
    running, pid = is_running()
    click.echo(f"{'running' if running else 'stopped'}" + (f" pid={pid}" if pid else ""))

@daemon.command()
@click.option("-n", "--lines", default=50)
def logs(lines):
    """Show daemon logs."""
    from .core.daemon import read_logs
    click.echo(read_logs(lines))


# ── psyche ──

@main.group()
def psyche():
    """User mind model."""
    pass

@psyche.command()
def show():
    """Show psyche profile."""
    from .psyche.profile import PsycheProfile
    p = PsycheProfile.load()
    click.echo(json.dumps(p.summary(), indent=2))

@psyche.command()
@click.option("--name", default=None)
@click.option("--roles", multiple=True)
@click.option("--domains", multiple=True)
@click.option("--values", multiple=True)
def init(name, roles, domains, values):
    """Initialize psyche profile."""
    from .psyche.profile import PsycheProfile
    p = PsycheProfile.load()
    if name: p.name = name
    if roles: p.roles = list(roles)
    if domains: p.domains = list(domains)
    if values: p.values = list(values)
    p.save()
    click.echo(f"Psyche initialized: {p.name}")

@psyche.command("export")
def psyche_export():
    """Export psyche as system prompt."""
    from .psyche.profile import PsycheProfile
    click.echo(PsycheProfile.load().to_system_prompt())


# ── task ──

@main.group()
def task():
    """Task queue management."""
    pass

@task.command()
@click.argument("name")
@click.option("--target", type=click.Choice(["local", "architect"]), default="local")
@click.option("--script", default=None)
@click.option("--prompt", default=None)
def add(name, target, script, prompt):
    """Add a task."""
    from .tasks.queue import add as add_task
    t = add_task(name, target, script=script, prompt=prompt)
    click.echo(f"Task {t.id}: {t.name} -> {t.target}")

@task.command("list")
@click.option("--status", default=None)
@click.option("--target", default=None)
def task_list(status, target):
    """List tasks."""
    from .tasks.queue import list_tasks
    for t in list_tasks(status=status, target=target):
        click.echo(f"  [{t.status}] {t.id} {t.name} -> {t.target}")

@task.command()
def purge():
    """Purge completed tasks."""
    from .tasks.queue import purge_done
    n = purge_done()
    click.echo(f"Purged {n} completed tasks")


# ── skill ──

@main.group()
def skill():
    """Skill registry."""
    pass

@skill.command("list")
@click.option("--category", default=None)
def skill_list(category):
    """List all skills."""
    from .skills.registry import list_all
    for s in list_all(category):
        desc = s['description'] if isinstance(s, dict) else s.description
        sid = s['id'] if isinstance(s, dict) else s.id
        cat = s['category'] if isinstance(s, dict) else s.category
        click.echo(f"  [{cat}] {sid}: {desc}")

@skill.command()
@click.argument("query")
def search(query):
    """Search skills."""
    from .skills.registry import search as skills_search
    for s in skills_search(query):
        click.echo(f"  [{s.category}] {s.id}: {s.name}")

@skill.command()
@click.argument("skill_id")
def run(skill_id):
    """Run a skill."""
    from .skills.registry import get as skills_get, render_script
    import subprocess
    skill = skills_get(skill_id)
    if not skill:
        click.echo(f"Skill {skill_id} not found", err=True)
        sys.exit(1)
    if skill.script:
        click.echo(f"Running: {skill.script}")
        subprocess.run(skill.script, shell=True)
    else:
        click.echo(f"Architect skill — prompt:\n{skill.template}")


# ── agent ──

@main.group()
def agent():
    """Agent management."""
    pass

@agent.command("list")
@click.option("--type", "agent_type", default=None)
def agent_list(agent_type):
    """List agents."""
    from .agents.delegator import list_agents
    for a in list_agents(agent_type):
        click.echo(f"  [{a.agent_type}] {a.id} {a.name}: {a.command}")

@agent.command()
@click.option("--name", required=True)
@click.option("--type", "agent_type", type=click.Choice(["runner", "watcher", "syncer"]), default="runner")
@click.option("--command", required=True)
def register(name, agent_type, command):
    """Register an agent."""
    from .agents.delegator import register as register_agent
    a = register_agent(name, agent_type, command)
    click.echo(f"Agent {a.id}: {a.name} ({a.agent_type})")


# ── version ──

@main.group()
def version():
    """Version control."""
    pass

@version.command()
def current():
    """Show current version info."""
    from .core.version import current as version_current
    click.echo(json.dumps(version_current(), indent=2))

@version.command()
@click.option("-m", "--message", default=None)
def snap(message):
    """Create a version snapshot."""
    from .core.version import snap as version_snap
    msg = message or f"snap {__import__('datetime').datetime.now().strftime('%H:%M')}"
    click.echo(version_snap(msg))

@version.command()
@click.option("-n", "--lines", default=20)
def log(lines):
    """Show version log."""
    from .core.version import log as version_log
    for entry in version_log(lines):
        click.echo(f"  {entry['hash']} {entry['message']}")


# ── chat ──

@main.command()
@click.argument("prompt")
@click.option("--web", is_flag=True, help="Enable web search")
@click.option("--shell", "allow_shell", is_flag=True, help="Enable shell access")
@click.option("--backend", default=None, help="LLM backend override")
def chat(prompt, web, allow_shell, backend):
    """Chat with HII."""
    from .config import Config
    from .orchestrator import run as orchestrate
    cfg = Config.load()
    if web:
        cfg.allow_search = True
        cfg.offline = False
    if allow_shell:
        cfg.allow_shell = True
    if backend:
        cfg.chat_backend = backend
    result = orchestrate(cfg, prompt)
    click.echo(result.text)
    if result.used_tools:
        click.echo(f"\n[tools: {', '.join(result.used_tools)}]", err=True)


# ── ingest ──

@main.command()
@click.option("--path", required=True, help="Directory to ingest")
def ingest(path):
    """Ingest files into RAG."""
    from .config import Config
    from .llm import get_client
    from .rag.vectordb import VectorStore
    from .rag.ingest import ingest_path

    cfg = Config.load()
    client = get_client(cfg.chat_backend, url=cfg.ollama_url)
    db = VectorStore(cfg.db_path)

    def embed_fn(texts):
        return client.embed(cfg.embed_model, texts)

    count = ingest_path(db, embed_fn, path)
    click.echo(f"Ingested {count} chunks from {path}")


# ── vox ──

@main.command()
@click.argument("mode", default="single", type=click.Choice(["single", "live", "status"]))
@click.option("--silence", default="1.5")
@click.option("--threshold", default="1%")
def vox(mode, silence, threshold):
    """Voice-to-action engine."""
    from .vox import cli as vox_cli
    import argparse
    args = argparse.Namespace(silence=silence, threshold=threshold)
    if mode == "live":
        vox_cli.cmd_live(args)
    elif mode == "status":
        vox_cli.cmd_status(args)
    else:
        vox_cli.cmd_single(args)

@main.command("vox-route")
@click.argument("text")
def vox_route(text):
    """Route text through VOX."""
    from .vox import cli as vox_cli
    import argparse
    args = argparse.Namespace(text=text.split())
    vox_cli.cmd_route(args)


# ── run ──

@main.command("run")
@click.argument("intent")
def run_intent(intent):
    """Execute an intent directly."""
    from .config import Config
    from .orchestrator import run as orchestrate
    cfg = Config.load()
    cfg.allow_shell = True
    result = orchestrate(cfg, intent)
    click.echo(result.text)


# ── config ──

@main.command("config")
@click.argument("action", type=click.Choice(["show", "migrate"]))
def config_cmd(action):
    """Config management."""
    from .config import Config
    if action == "show":
        from dataclasses import asdict
        cfg = Config.load()
        click.echo(json.dumps(asdict(cfg), indent=2))
    elif action == "migrate":
        cfg = Config.load()
        cfg.save()
        click.echo(f"Config saved to ~/.hii/config.json")


# ── serve ──

@main.command()
@click.option("--port", default=8888)
def serve(port):
    """Start HTTP dashboard."""
    from .serve.server import start
    start(port=port)


# ── caps (capability map) ──

@main.group()
def caps():
    """Capability map — what this machine can do."""
    pass


@caps.command("show")
def caps_show():
    """Pretty-print the current capability map (uses cache if fresh)."""
    from . import capabilities
    cap = capabilities.get_capability_map()
    counts = cap.counts()
    click.echo(f"scan_id={cap.scan_id}  at={cap.generated_at}")
    if cap.host:
        click.echo(f"  host: {cap.host.get('hostname')} ({cap.host.get('os')} {cap.host.get('architecture')})  user={cap.host.get('username')}")
    click.echo("")
    for k, v in counts.items():
        click.echo(f"  {k:10} {v}")
    click.echo("")
    available_apps = [a.name for a in cap.apps if a.available]
    if available_apps:
        click.echo("  apps available: " + ", ".join(sorted(available_apps)))
    online_services = [s.name for s in cap.services if s.available]
    click.echo("  services online: " + (", ".join(online_services) if online_services else "(none)"))
    if cap.warnings:
        click.echo(f"  warnings: {len(cap.warnings)}")
    if cap.errors:
        click.echo(f"  errors:   {len(cap.errors)}")


@caps.command("refresh")
def caps_refresh():
    """Force rescan and overwrite cache."""
    from . import capabilities
    cap = capabilities.refresh_capability_map()
    counts = cap.counts()
    click.echo(f"refreshed: scan_id={cap.scan_id}")
    for k, v in counts.items():
        click.echo(f"  {k:10} {v}")
    if cap.errors:
        click.echo(f"errors: {len(cap.errors)}")


@caps.command("export")
@click.option("--format", "fmt", type=click.Choice(["json", "llm"]), default="llm")
def caps_export(fmt):
    """Export the capability map. `llm` = agent-readable markdown; `json` = raw."""
    from . import capabilities
    payload = capabilities.export_as_json() if fmt == "json" else capabilities.export_for_llm()
    # Force UTF-8 on stdout so Unicode (checkmarks, arrows) doesn't crash on Windows cp1252.
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
    except AttributeError:
        click.echo(payload)


@caps.command("diff")
def caps_diff():
    """Compare current capability map vs previous snapshot."""
    from .capabilities import cache as cap_cache, export as cap_export
    cur = cap_cache.read_current()
    prev = cap_cache.read_previous()
    if not cur:
        click.echo("no current capability map — run `hii caps refresh` first")
        return
    if not prev:
        click.echo("no previous capability map yet — refresh twice to see a diff")
        return
    d = cap_export.diff(cur, prev)
    for kind, info in d.items():
        if info["added_count"] or info["removed_count"] or info["flipped_count"]:
            click.echo(f"\n{kind}:")
            if info["added"]:
                click.echo(f"  + added ({info['added_count']}): " + ", ".join(info["added"]))
            if info["removed"]:
                click.echo(f"  - removed ({info['removed_count']}): " + ", ".join(info["removed"]))
            if info["availability_flipped"]:
                click.echo(f"  ~ availability changed ({info['flipped_count']}):")
                for line in info["availability_flipped"]:
                    click.echo(f"      {line}")


if __name__ == "__main__":
    main()
