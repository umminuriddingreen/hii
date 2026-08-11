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

Interactive conversation preserves context across turns and streams the local
model's provider-supplied thinking and response text as it arrives. Tool
actions and results remain visible in sequence, so bare `hii` shows what the
model is considering and doing instead of replacing activity with a generic
working indicator.

Type `/help` inside bare `hii` for the conversational control surface. It
includes model switching, automatic/manual compaction, token and throughput
activity, managed Codex and Claude sessions, local schedules, Apple Calendar,
system resources, proof inspection, and automatically learned skill drafts.
Schedule, Calendar, and system-resource controls require a `preview` build.
`/thinking off|compact|raw` controls provider-supplied thinking display. Model
response text continues streaming in every mode; `raw` is the default.

There is no tool-step ceiling by default. HII continues until the model
finishes or the operator interrupts with Esc/Ctrl-C. `--max-steps N` remains
available only when the operator deliberately wants a finite ceiling; `0`
means unlimited. If the model returns the same rejected action three times
against unchanged workspace/proof state, HII reports `MODEL LOOP DETECTED` and
returns control while preserving the session and completed workspace changes.
This is convergence recovery, not a run-step limit.

Verified conversational workflows are conservatively analyzed after the turn.
When HII finds a genuinely repeatable procedure it creates or updates a draft
under `~/.hii/skills/proposed/`. Drafting is automatic; registration and skill
execution remain proof-backed operator decisions.

Explicit `hii run` uses the same live model stream. Add `--verbose` for the
full contract and backend receipt details.

Native runs preload a bounded, source-labelled context capsule containing the
workspace's `AGENTS.md`, current Git state, and up to three prior HII receipts
for the same workspace. Historical context is evidence, never a replacement
for the current operator instruction. Use `--no-context` for an isolated run.

Use `--done-when` to bind the receipt to a concrete acceptance criterion and
repeat `--verify` for deterministic local checks that HII itself must run
before marking the receipt complete:

```sh
hii run \
  --done-when "the focused tests pass and help documents the new flag" \
  --verify "cargo test --manifest-path cli/Cargo.toml" \
  "add the feature with minimal changes"
```

Declared verification commands cannot perform external actions. Their exact
commands, outputs, and pass/fail status are recorded in the receipt alongside
the context source list. Receipts distinguish files touched by the run from
pre-existing dirty worktree state, so concurrent user or agent work is not
misattributed as a new artifact.

## Governed lifecycle hooks

HII can run explicitly approved operator-local hooks at `sessionStart`,
`userPrompt`, `preTool`, `postTool`, and `stop`. Configure them in
`~/.hii/config/hooks.json`:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "hooks": {
    "preTool": [
      {
        "name": "protect-generated-files",
        "command": "scripts/hii-hooks/protect.sh",
        "matcher": "write|edit",
        "approved": true,
        "timeoutMs": 3000
      }
    ],
    "postTool": [
      {
        "name": "format-edits",
        "command": "scripts/hii-hooks/format.sh",
        "matcher": "write|edit",
        "approved": true,
        "timeoutMs": 10000,
        "mutatesWorkspace": true
      }
    ]
  }
}
```

Hook commands are literal workspace-relative executable paths, with an optional
literal `args` array; shell command strings, absolute paths, traversal,
symlinks, and non-executable files are rejected. The operator-local config must
be a regular file owned by the current user and cannot be group- or
world-writable. Every hook needs `approved: true` before it can execute.

HII sends bounded redacted event JSON on standard input and clears the process
environment before restoring only a minimal `PATH`, isolated `HOME`, workspace,
session, locale, terminal, and temporary-directory context. Hook output is
capped at 8 KiB, redacted, written to the run event stream, and retained in
receipt schema 4. Timeouts terminate the hook process group; the default is
three seconds and the maximum is 30 seconds.

`userPrompt` and `preTool` hooks can deny an action with exit code 2 or
`{"decision":"deny","reason":"..."}`. A timeout or launch failure also fails
closed for those policy events. A successful `sessionStart` or `postTool` hook
that declares `mutatesWorkspace` invalidates earlier proof, so HII must verify
the resulting state again. Use `/hooks` to inspect effective policy and
`--no-hooks` for an explicitly hook-free local session. Public-test sessions
disable hooks categorically.

Approved hooks are trusted host code, not an operating-system sandbox. Protect
the operator-local config and review executable changes with the same care as
any other local automation.

## Agent loop

```text
goal
→ inspect approved workspace
→ choose one typed tool
→ act
→ stream model and tool output
→ adjust
→ run an explicit verification tool
→ write receipt
```

The default work and review model is resolved per provider, because model names
are not portable between runtimes: Ollama and LM Studio default to
`qwen3.6:35b-mlx`, HII Native to `Qwen/Qwen3.6-35B-A3B`. `--review` sends the
final result and proof record to that provider's review model for a stricter
second pass; `--review-model` overrides it. Ollama remains a replaceable local
model provider; workspace policy, tools, events, and proof belong to HII/AII.

When the operator names no model, a default that is not installed is an error
listing what is available — HII never silently substitutes a different model,
because the receipt would then misreport what produced the run.

HII can also talk directly to its native Rust/Metal runner through the same
OpenAI-compatible boundary. The runner lives at
`/Users/ummi/dev/hii-native-runner` and binds to loopback port 11435 by
default:

```sh
HII_MODEL_PROVIDER=native \
HII_MODEL_URL=http://127.0.0.1:11435 \
hii --model Qwen/Qwen3.6-35B-A3B
```

The native provider supports incremental response and reasoning streams,
interrupt cancellation, model discovery, and token telemetry. HII continues
to own the agent loop, tools, verification, and durable receipts.

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
- Shell commands have a timeout, output cap, workspace path checks, and
  destructive-system guards.
- Local HTTP verification only accepts `127.0.0.1` or `localhost` URLs.
- File deletion is never silent: recognizable deletion commands require an
  explicit live yes/no approval, including under YOLO authority. Stdio/MCP
  execution refuses deletion because it has no approval channel.
- Publishing, pushing, spending, messaging, and external access are never
  inferred from a goal.

The shell guard is not an operating-system sandbox. It is a fast policy layer
for ordinary local work. Higher-risk execution should move behind an AII
capability runner with stronger isolation rather than adding a `--force` mode.

## Build and proof

```sh
npm run cli:check
npm run cli:build
npm run hii:launcher:check
npm run cli:eval:local
hii doctor
hii --cwd /path/to/workspace "make the change and verify it"
hii proof
```

`npm run cli:eval:local` is the opt-in live local-model gate. It evaluates the
Qwen work models through HII's real bounded run, tool, verification, and receipt
path, then probes Gemma's bounded text-utility behavior. The suite uses isolated
temporary workspaces and an isolated HII runtime; it does not add a public CLI
command or write evaluation receipts into the user's normal `~/.hii` runtime.

The canonical global launcher is `scripts/hii-launcher.sh`. Install or refresh
`/Users/ummi/bin/hii` with `npm run cli:install`. It executes
`/Users/ummi/hii/target/release/hii`, builds it on first use when absent, and
fingerprints the manifests, lockfile, and CLI Rust source tree on every launch.
Any local source change—including an uncommitted edit, addition, or deletion—
rebuilds before the command runs. There is no separate CLI update step during
local development. A compile failure is surfaced instead of silently running a
stale binary. `npm run ci:full` also builds the release workspace, so a green
full CI run and the installed command exercise the same source.

## Migration rule

Port existing command families in this order: deterministic local reads,
append-only local writes, managed runtime commands, then networked commands.
Remove a Node delegation only after golden output, alias, JSON-schema, and exit
code parity tests pass. The Node daemon `aii/daemon/hiid.mjs` is a separate AII
execution authority and must not be rewritten as part of CLI dispatch work.
