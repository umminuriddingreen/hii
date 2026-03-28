# Yin-Yang-Ummi Contract

## Core Principles

1. **Everything through HII** — all tools, extensions, configs, and system capabilities must be version-controlled and extensible through the HII system. Nothing lives outside the system untracked.

2. **Event-first architecture** — every agent action, observation, tool call, and human input is a typed event in an append-only stream. The UI is a projection of events, not the source of truth.

3. **Deterministic shell, generative content** — the layout and interaction model are fixed and keyboard-first. Agents populate typed slots with rich content, but never invent arbitrary DOM.

4. **Filesystem bridge first** — agent-to-agent coordination happens through `bridge/messages/*.json`. Inspectable, debuggable, replayable. Transport-agnostic later.

5. **Rust for compute, TypeScript for surface** — Rust handles event ingestion, indexing, file watching, process control. TypeScript handles UI iteration until contracts stabilize.

6. **Bridge chat is a first-class pane** — Yin, Yang, and Ummi communicate in a shared live chat. All agent coordination is auditable, not hidden.

## Message Schema

```json
{
  "id": 1,
  "from": "yin|yang|ummi",
  "to": "all|yin|yang|ummi",
  "timestamp": "ISO8601",
  "type": "message|proposal|response|decision|artifact|question",
  "content": "string",
  "schema_version": 1,
  "reply_to": null,
  "session_id": null,
  "tags": [],
  "artifacts": []
}
```

## Agents

- **Yin** = Codex CLI (GPT-5.4) — synthesis, connectivity, harmony
- **Yang** = Claude Code (Opus 4.6) — pattern, execution, precision
- **Ummi** = the human builder, the will, the vision

## V1 Modules (agreed by Yin + Yang)

- `event-store` — append/read/replay event stream
- `bridge` — file-backed agent message transport
- `session-orchestrator` — active tasks, agents, tools, subscriptions
- `surface-shell` — static application chrome and layout
- `surface-renderer` — typed panel primitives from view models
- `terminal-adapter` — CLI stdout/stderr and structured events
- `artifact-store` — durable references to files, diffs, notes, screenshots
