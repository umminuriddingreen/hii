# HII Rust CLI

The Rust CLI is HII's fast front door for turning a local goal into bounded
work, verification, and a receipt. It is part of the existing HII/AII system;
it does not introduce another daemon, database, or product surface.

## Command surface

```text
hii                 open an ongoing conversational workspace session
hii [goal]          run a quoted goal non-interactively
hii run [goal]      run one bounded local agent workflow
hii status          show workspace, Git, Ollama, and latest-proof state
hii doctor          check the local execution prerequisites
hii models          show installed local model roles
hii proof [id]      inspect a durable run receipt
hii board [action]  local kanban/todo board (list/add/move/done/edit/dedupe)
```

The native surface stays deliberately small. Existing HII command families
are delegated to `scripts/hii-cli.mjs` with inherited standard I/O and
environment until their schemas and exit behavior have Rust parity tests.

## Parity freeze

The default native command surface is frozen to `run`, `status`, `doctor`,
`models`, `proof`, and `board`. Every other command family must continue
through `legacy::run` and `scripts/hii-cli.mjs` until family-specific parity
tests prove its aliases, flags, output, JSON schema, and exit behavior.
Unmigrated schedule, calendar, and system-monitor experiments remain
available only in builds made with the non-default Cargo feature `preview`.

`board` was migrated 2026-07-21 (see `cli/src/board.rs`): append-only local
writes to `~/.hii/board/tasks.jsonl`, no network or managed-runtime
dependency, matching the migration order below. Verified against the live
production board (`~/.hii/board/tasks.jsonl`, 23 tasks including duplicate
archival) with `diff <(hii board list --all) <(node scripts/hii-cli.mjs board
list --all)` producing zero diff, plus unit tests in `cli/src/board.rs`.

Interactive conversation preserves context across turns and renders only the
assistant's useful response. Internal model actions and tool observations are
persisted silently; they are not terminal UI.

Type `/help` inside bare `hii` for the conversational control surface. It
includes model switching, automatic/manual compaction, token and throughput
activity, managed Codex and Claude sessions, local schedules, Apple Calendar,
system resources, proof inspection, and automatically learned skill drafts.
Schedule, Calendar, and system-resource controls require a `preview` build.
`/thinking off|compact|detailed` changes only the activity rail; raw hidden
reasoning is never printed.

Verified conversational workflows are conservatively analyzed after the turn.
When HII finds a genuinely repeatable procedure it creates or updates a draft
under `~/.hii/skills/proposed/`. Drafting is automatic; registration and skill
execution remain proof-backed operator decisions.

Explicit `hii run` uses the same quiet presentation. Add `--verbose` only when
debugging the model/tool protocol or locating a specific backend receipt.

## Agent loop

```text
goal
→ inspect approved workspace
→ choose one typed tool
→ act
→ observe bounded output
→ adjust
→ run an explicit verification tool
→ write receipt
```

`qwen3.6:27b-mlx` is the default work model. `--review` sends the final result
and proof record to `qwen3.6:35b-mlx` for a stricter second pass. Ollama remains
a replaceable local model provider; workspace policy, tools, events, and proof
belong to HII/AII.

## Runtime contract

Each run is stored under:

```text
~/.hii/runs/cli/<run-id>/events.jsonl
~/.hii/runs/cli/<run-id>/receipt.json
~/.hii/runs/cli/latest
~/.hii/conversations/cli/<conversation-id>.jsonl
```

The event stream records model and tool progress with secret-like lines
redacted. The receipt records the goal, workspace, models, step count,
verification results, Git status, risk, and next action.

## Boundaries

- Every filesystem path is resolved beneath one canonical workspace root.
- Direct reads and writes under `.git` and common secret-bearing files are
  rejected.
- Shell commands have a timeout, output cap, path checks, and destructive
  pattern guard.
- Local HTTP verification only accepts `127.0.0.1` or `localhost` URLs.
- Publishing, pushing, spending, messaging, deletion, and external access are
  never inferred from a goal.

The shell guard is not an operating-system sandbox. It is a fast policy layer
for ordinary local work. Higher-risk execution should move behind an AII
capability runner with stronger isolation rather than adding a `--force` mode.

## Build and proof

```sh
npm run cli:check
npm run cli:build
hii doctor
hii --cwd /path/to/workspace "make the change and verify it"
hii proof
```

The global launcher at `/Users/ummi/bin/hii` executes
`/Users/ummi/hii/target/release/hii` and builds it on first use when absent.

## Migration rule

Port existing command families in this order: deterministic local reads,
append-only local writes, managed runtime commands, then networked commands.
Remove a Node delegation only after golden output, alias, JSON-schema, and exit
code parity tests pass. The Node daemon `aii/daemon/hiid.mjs` is a separate AII
execution authority and must not be rewritten as part of CLI dispatch work.
