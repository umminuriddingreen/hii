# HII — Human Information Interface

## CRITICAL: Skills-First Protocol
Before doing ANY action, run:
```
hii skill search KEYWORD
```
If a skill exists, execute it. Do NOT re-reason what's already codified.
If no skill exists, do the work, then register it as a new skill.

## Skill Registry
- Location: `~/.hii/skills/`
- List: `hii skill list`
- Search: `hii skill search QUERY`
- Run: `hii skill run SKILL_ID`

## Token Conservation Rules
- Tokens are sacred. Every token must earn its place.
- Local models (Ollama) = scripts only. NEVER free-form reasoning.
- Search skills before acting. Always.
- Be concise. No fluff.

## Architecture (v0.2 — pure Python)
```
hii/                    # Python package (pip install -e .)
  cli.py               # Click-based unified CLI
  config.py            # Typed config (~/.hii/config.json)
  orchestrator.py      # Intent classification + tool loop
  memory.py            # JSONL chat memory
  core/daemon.py       # Self-healing Unix daemon
  psyche/profile.py    # User mind model
  tasks/queue.py       # Persistent task queue (local/architect)
  skills/registry.py   # Skill schema registry (109 skills)
  agents/delegator.py  # Managed subprocess agents
  llm/                 # Ollama, Claude, LM Studio backends
  rag/                 # LanceDB vectordb, ingest, chunking
  tools/               # Web search, shell, academic search
  vox/                 # Voice-to-action (mlx-whisper + Ollama routing)
  serve/               # HTTP dashboard
  harness/             # Rhino MCP + Grasshopper bridge
```

## CLI
```
hii daemon start|stop|status|logs
hii psyche show|init|export
hii task add|list|purge
hii skill list|search|run
hii agent register|list
hii version current|snap|log
hii chat "prompt" [--web] [--shell] [--backend ollama]
hii ingest --path ./dir
hii vox single|live|status
hii vox-route "text"
hii run "intent"
hii config show|migrate
hii serve [--port 8888]
```

## Conventions
- Python only. Dataclasses, type hints, no heavy frameworks.
- Dependencies: click, httpx, pydantic, lancedb
- Tests: pytest (tests/)
- Git: conventional commits with scopes
- New capabilities → register as skill immediately

## Runtime
- Config: `~/.hii/config.json`
- Data: `~/.hii/` (psyche.json, taskq.json, agents.json, skills/, memory/, hii.db)
