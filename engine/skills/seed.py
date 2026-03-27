#!/usr/bin/env python3
"""Seed all built-in HII skills into the registry."""

from .registry import Skill, register

BUILTIN_SKILLS = [
    # ── Daemon ──
    Skill(
        id="daemon-start",
        name="Start HII Daemon",
        description="Start the self-healing persistence daemon in background",
        category="daemon",
        target="local",
        inputs={},
        script="python3 -m engine.core.daemon start",
        tags=["daemon", "start", "persistence"],
        examples=["hii skill run daemon-start"],
    ),
    Skill(
        id="daemon-stop",
        name="Stop HII Daemon",
        description="Gracefully stop the daemon and all workers",
        category="daemon",
        target="local",
        inputs={},
        script="python3 -m engine.core.daemon stop",
        tags=["daemon", "stop"],
    ),
    Skill(
        id="daemon-status",
        name="Daemon Status",
        description="Check if daemon is running and list workers",
        category="daemon",
        target="local",
        inputs={},
        script="python3 -m engine.core.daemon status",
        tags=["daemon", "status", "health"],
    ),
    Skill(
        id="daemon-logs",
        name="Daemon Logs",
        description="Read recent daemon log lines",
        category="daemon",
        target="local",
        inputs={"lines": "int (default 50)"},
        script="python3 -m engine.core.daemon logs {lines}",
        tags=["daemon", "logs", "debug"],
    ),

    # ── Psyche ──
    Skill(
        id="psyche-init",
        name="Initialize Psyche",
        description="Seed psyche profile with identity, roles, domains, values",
        category="psyche",
        target="local",
        inputs={"name": "str", "roles": "space-separated", "domains": "space-separated", "values": "space-separated"},
        script="python3 -m engine.cli psyche init --name '{name}' --roles {roles} --domains {domains} --values {values}",
        tags=["psyche", "identity", "init"],
        examples=["hii skill run psyche-init --name 'Ummi Green' --roles builder architect"],
    ),
    Skill(
        id="psyche-show",
        name="Show Psyche Summary",
        description="Display compact psyche profile summary",
        category="psyche",
        target="local",
        inputs={},
        script="python3 -m engine.cli psyche show",
        tags=["psyche", "show", "summary"],
    ),
    Skill(
        id="psyche-export",
        name="Export Psyche as System Prompt",
        description="Export psyche profile as injectable system prompt text",
        category="psyche",
        target="local",
        inputs={},
        script="python3 -m engine.cli psyche export",
        tags=["psyche", "export", "prompt"],
    ),
    Skill(
        id="psyche-learn",
        name="Learn from Conversation",
        description="Extract cognitive patterns from a conversation and update psyche",
        category="psyche",
        target="architect",
        inputs={"conversation": "str - the conversation text to analyze"},
        template="Analyze this conversation and extract: traits, preferences, knowledge domains, corrections, values. Conversation:\n{conversation}",
        tags=["psyche", "learn", "extract"],
    ),

    # ── Tasks ──
    Skill(
        id="task-add-local",
        name="Add Local Task",
        description="Queue a scripted task for local model execution",
        category="task",
        target="local",
        inputs={"name": "str", "script": "str - exact command to run"},
        script="python3 -m engine.cli task add --name '{name}' --target local --script '{script}'",
        tags=["task", "queue", "local"],
    ),
    Skill(
        id="task-add-architect",
        name="Add Architect Task",
        description="Queue a reasoning task for Claude/architect",
        category="task",
        target="local",
        inputs={"name": "str", "prompt": "str - the reasoning intent"},
        script="python3 -m engine.cli task add --name '{name}' --target architect --prompt '{prompt}'",
        tags=["task", "queue", "architect"],
    ),
    Skill(
        id="task-list",
        name="List Tasks",
        description="List all tasks in queue with status",
        category="task",
        target="local",
        inputs={"status": "str (optional) - queued|running|done|failed"},
        script="python3 -m engine.cli task list",
        tags=["task", "list", "status"],
    ),
    Skill(
        id="task-purge",
        name="Purge Completed Tasks",
        description="Remove all done tasks from queue",
        category="task",
        target="local",
        inputs={},
        script="python3 -m engine.cli task purge",
        tags=["task", "purge", "clean"],
    ),

    # ── Agents ──
    Skill(
        id="agent-register",
        name="Register Agent",
        description="Register a new managed agent (runner/watcher/syncer)",
        category="agent",
        target="local",
        inputs={"name": "str", "type": "runner|watcher|syncer", "command": "str - exact command"},
        script="python3 -m engine.cli agent register --name '{name}' --type {type} --command '{command}'",
        tags=["agent", "register", "spawn"],
    ),
    Skill(
        id="agent-list",
        name="List Agents",
        description="List all registered agents",
        category="agent",
        target="local",
        inputs={},
        script="python3 -m engine.cli agent list",
        tags=["agent", "list"],
    ),
    Skill(
        id="agent-run",
        name="Run Agent",
        description="Execute a registered agent's command",
        category="agent",
        target="local",
        inputs={"id": "str - agent ID"},
        script="python3 -m engine.cli agent run --id {id}",
        tags=["agent", "run", "execute"],
    ),

    # ── Skills Meta ──
    Skill(
        id="skill-list",
        name="List All Skills",
        description="List all registered HII skills (token-efficient index)",
        category="skills",
        target="local",
        inputs={"category": "str (optional) - filter by category"},
        script="python3 -c \"from engine.skills.registry import list_all; import json; print(json.dumps(list_all({category}), indent=2))\"",
        tags=["skills", "list", "index", "search"],
    ),
    Skill(
        id="skill-search",
        name="Search Skills",
        description="Search skills by keyword — do this BEFORE doing anything",
        category="skills",
        target="local",
        inputs={"query": "str - search keyword"},
        script="python3 -c \"from engine.skills.registry import search; import json; [print(f'{{s.id}}: {{s.name}} ({{s.category}})') for s in search('{query}')]\"",
        tags=["skills", "search", "find", "lookup"],
    ),

    # ── RAG / HII CLI ──
    Skill(
        id="rag-ingest",
        name="Ingest Files to RAG",
        description="Index files into local LanceDB vector store",
        category="rag",
        target="local",
        inputs={"path": "str - folder path to ingest"},
        script="cd ~/hii && node dist/cli.js ingest --path '{path}'",
        tags=["rag", "ingest", "index", "files"],
    ),
    Skill(
        id="rag-chat",
        name="Chat with RAG",
        description="Ask a question with local file search context",
        category="rag",
        target="local",
        inputs={"prompt": "str"},
        script="cd ~/hii && node dist/cli.js chat '{prompt}'",
        tags=["rag", "chat", "search", "ask"],
    ),
    Skill(
        id="web-search",
        name="Web Search Chat",
        description="Ask with web search enabled",
        category="web",
        target="local",
        inputs={"prompt": "str"},
        script="cd ~/hii && node dist/cli.js chat --web --online '{prompt}'",
        tags=["web", "search", "online"],
    ),
    Skill(
        id="scholarly-search",
        name="Academic Paper Search",
        description="Search academic papers (arXiv, OpenAlex, Crossref)",
        category="web",
        target="local",
        inputs={"query": "str"},
        script="cd ~/hii && node dist/cli.js chat --web --scholarly --online '{query}'",
        tags=["academic", "papers", "scholarly", "research"],
    ),
    Skill(
        id="hii-serve",
        name="Start HII Server",
        description="Start local HTTP API server",
        category="server",
        target="local",
        inputs={"port": "int (default 8787)"},
        script="cd ~/hii && node dist/cli.js serve --port {port} --web --scholarly",
        tags=["server", "http", "api"],
    ),

    # ── Git ──
    Skill(
        id="git-status",
        name="Git Status",
        description="Show working tree status for HII repo",
        category="git",
        target="local",
        inputs={},
        script="cd ~/hii && git status --short",
        tags=["git", "status"],
    ),
    Skill(
        id="git-commit",
        name="Git Commit",
        description="Stage and commit changes to HII repo",
        category="git",
        target="local",
        inputs={"message": "str - commit message"},
        script="cd ~/hii && git add -A && git commit -m '{message}'",
        tags=["git", "commit", "save"],
    ),
    Skill(
        id="git-log",
        name="Git Log",
        description="Show recent commit history",
        category="git",
        target="local",
        inputs={"n": "int (default 10)"},
        script="cd ~/hii && git log --oneline -{n}",
        tags=["git", "log", "history"],
    ),

    # ── ComfyUI ──
    Skill(
        id="comfyui-start",
        name="Start ComfyUI",
        description="Spawn ComfyUI + MCP server",
        category="comfyui",
        target="local",
        inputs={},
        script="cd ~/hii && node dist/cli.js comfyui start",
        tags=["comfyui", "image", "generation"],
    ),
    Skill(
        id="comfyui-status",
        name="ComfyUI Status",
        description="Check ComfyUI + MCP server status",
        category="comfyui",
        target="local",
        inputs={},
        script="cd ~/hii && node dist/cli.js comfyui status",
        tags=["comfyui", "status"],
    ),

    # ── System ──
    Skill(
        id="ollama-list",
        name="List Ollama Models",
        description="Show all pulled Ollama models",
        category="system",
        target="local",
        inputs={},
        script="ollama list",
        tags=["ollama", "models", "list"],
    ),
    Skill(
        id="ollama-status",
        name="Ollama Status",
        description="Check if Ollama is running",
        category="system",
        target="local",
        inputs={},
        script="curl -s http://127.0.0.1:11434/api/tags | python3 -c \"import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\\\"models\\\", []))} models loaded')\"",
        tags=["ollama", "health", "status"],
    ),

    # ── Notes ──
    Skill(
        id="audio-note",
        name="Audio to Note",
        description="Transcribe audio file and generate markdown note",
        category="notes",
        target="local",
        inputs={"file": "str - path to audio file", "title": "str (optional)"},
        script="cd ~/hii && node dist/cli.js notes audio --file '{file}' --title '{title}'",
        tags=["audio", "transcribe", "notes", "voice"],
    ),

    # ── Memory ──
    Skill(
        id="memory-check",
        name="Check Obsidian Vault",
        description="Verify Obsidian vault path and status",
        category="memory",
        target="local",
        inputs={},
        script="cd ~/hii && node dist/cli.js memory check",
        tags=["memory", "obsidian", "vault", "check"],
    ),
]


def seed_all():
    """Register all built-in skills."""
    for skill in BUILTIN_SKILLS:
        register(skill)
    print(f"Seeded {len(BUILTIN_SKILLS)} skills into ~/.hii/skills/")


if __name__ == "__main__":
    seed_all()
