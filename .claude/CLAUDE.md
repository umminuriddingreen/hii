# HII — Human Information Interface

## CRITICAL: Skills-First Protocol
Before doing ANY action, run:
```
python3 -c "from engine.skills.registry import search; [print(f'{s.id}: {s.name}') for s in search('KEYWORD')]"
```
If a skill exists for the action, execute its script. Do NOT re-reason what's already codified.
If no skill exists, do the work, then register it as a new skill.

## Skill Registry
- Location: `~/.hii/skills/`
- Index: `python3 -c "from engine.skills.registry import list_all; import json; print(json.dumps(list_all(), indent=2))"`
- Search: `python3 -c "from engine.skills.registry import search; [print(f'{s.id}: {s.name}') for s in search('QUERY')]"`

## Token Conservation Rules
- Tokens are sacred. Every token must earn its place.
- Local models (Ollama) = scripts only. NEVER free-form reasoning.
- Search skills before acting. Always.
- Be concise. No fluff.

## Architecture
- `src/` — TypeScript CLI (RAG, Ollama, Obsidian memory, web search, ComfyUI)
- `engine/` — Python persistence engine
  - `core/daemon.py` — self-healing Unix daemon
  - `psyche/profile.py` — user mind model
  - `psyche/learner.py` — pattern extraction from conversations
  - `tasks/queue.py` — persistent task queue (local vs architect)
  - `agents/delegator.py` — managed subprocess agents
  - `skills/registry.py` — skill schema registry
- `~/.hii/` — runtime data (psyche.json, taskq.json, agents.json, skills/, daemon.pid)

## Conventions
- Python: dataclasses, type hints, no heavy frameworks
- TypeScript: ES modules, 2-space indent, camelCase
- Git: conventional commits with scopes
- New capabilities → register as skill immediately
