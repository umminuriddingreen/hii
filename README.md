# HII — Human Information Interface

HII is a local-first, user-owned interface that turns human intent into
verified agent work across context, tools, files, machines, memory, and
reusable capabilities.

AII—the Agent Information Interface—is the coordination, policy, and execution
layer beneath HII. It publishes capabilities, manages agents, governs actions,
and records proof through shared runtime state under `~/.hii`.

Read [the HII/AII master context](docs/HII_AII_MASTER_CONTEXT.md) before making
product or architecture changes.

## Current Product Decision

The active product is **HII Knowledge Workspace**, built on the Context Dock
foundation:

> Build knowledge once. HII keeps it linked, source-aware, agent-ready, and
> accountable.

The intended vertical slice is:

```text
selected project
→ visible source permissions
→ deterministic local inventory and extraction
→ source-linked project model
→ Markdown notes, folders, tags, links, backlinks, and graph
→ task-specific context pack
→ user review
→ bounded MCP delivery
→ verified agent result
→ durable receipt and project memory
```

Authored knowledge lives in one user-selected, visible Markdown vault (default
recommendation: `~/Documents/HII`). SQLite under `~/.hii/hii.db` provides the
rebuildable FTS5 index, provenance, history, events, and operational state. An
asset can be copied into the vault or explicitly linked in place. Project
System Maps are source-linked views over the same knowledge—not a separate
diagram product or chat transcript.

The knowledge and Context Dock loop is not yet complete. Existing boards, console, daemon, jobs,
capabilities, bridge, packs, link, credit, exchange, and Termite
surfaces are implementation history or substrate. They are not permission to
widen the Context Dock 0.1 release into a marketplace, AI chat product,
decentralized compute network, geometry platform, or personal-data harvester.

## HII / AII Boundary

- **HII** owns the human-facing Next.js/Tauri interface, context review,
  projects, boards, approvals, activity, verification, and receipts.
- **AII** owns agent lifecycle, capabilities, policy, managed execution,
  handoffs, proof collection, runtime configuration, and skill promotion.
- **Shared runtime** under `~/.hii` is the explicit contract between them.
- **Models** are replaceable reasoning engines; they do not own permissions or
  durable project truth.

The visual interface and desktop application are called **HII**. Its spatial
workspace displays and controls governed state published by AII through the
shared runtime; there is no separately named interface product.

The dependency direction is:

```text
AII → publishes governed state → ~/.hii ← HII reads and presents state
```

## Current Coordinates

```text
Repository:       /Users/ummi/hii
Runtime:          /Users/ummi/.hii
Launcher:         /Users/ummi/bin/hii
Context database: /Users/ummi/.hii/hii.db
Knowledge vault:  user-selected Markdown folder (recommended ~/Documents/HII)
AII source:       /Users/ummi/hii/aii
Capability source:/Users/ummi/hii/aii/capabilities/registry.json
```

`/Users/ummi/hii-old` is legacy evidence only if present. It is never a current
execution or validation target.

## Agent Bootstrap

```sh
hii context --json
hii og status
hii caps show
git status --short
```

Live command, repository, process, and runtime evidence wins over cached
summaries.

## Terminal Control Plane

The `hii` command is a fast Rust workspace agent for the same governed HII/AII
loop. Bare `hii` opens a clean, ongoing conversation with session memory and
quiet access to workspace tools. A quoted intent or `hii run` starts explicit
non-interactive work.

```sh
hii
hii "fix the failing tests and prove the result"
hii run --review "ship the smallest verified patch"
hii status
hii doctor
hii models
hii proof

# Existing HII contracts remain available during the Rust migration.
hii context --json
hii caps show
hii task "Add source provenance to the import receipt" --coordinate /Users/ummi/hii
hii work
```

The default workhorse is local `qwen3.6:27b-mlx`. `--review` asks
`qwen3.6:35b-mlx` for a stronger final proof review. Each run is bounded by an
explicit workspace and step limit, uses typed read/search/write/shell/verify
tools, and persists events plus a receipt under `~/.hii/runs/cli/`.

Conversational turns show only HII's natural response. Model selection, tool
steps, run IDs, and receipt bookkeeping remain backend state. Conversation
events are stored under `~/.hii/conversations/cli/`; when a turn uses workspace
tools, its proof remains available through `hii proof` without cluttering chat.
Explicit runs are quiet by default too; `hii run --verbose` exposes diagnostic
plumbing when it is genuinely useful.

The native surface is intentionally small: `run`, `status`, `doctor`, `models`,
and `proof`. Existing command families are delegated to the current Node
implementation until Rust parity tests prove each migration. This keeps one
public `hii` doorway while avoiding a flag-day loss of capabilities.

The local shell boundary blocks known destructive patterns and paths outside
the selected workspace, but it is not an operating-system sandbox. HII never
infers permission to push, publish, spend, message, delete, or expose secrets.

## Verified-Work Loop

Every serious workflow should close this loop:

```text
intent
→ bounded task
→ approved capability
→ execution logs and artifacts
→ verification
→ receipt
→ durable memory
→ reusable skill
```

After meaningful work, agents record a structured receipt:

```sh
hii skill report \
  --agent codex \
  --project hii \
  --coordinate /Users/ummi/hii \
  --summary "Implemented a bounded workflow" \
  --outcome completed \
  --verification verified \
  --checks "npm run build" \
  --proof "/path/to/proof"
```

Repeatable work may create a draft candidate:

```sh
hii skill report ... --repeatable --skill-id verify-hii-build
hii skill list --all
hii skill show verify-hii-build
```

Drafts are not executable skills. Registration requires proof or a declared
verification command plus explicit operator review:

```sh
hii skill register verify-hii-build --reviewed-by ummi
hii skill doctor
hii skill export verify-hii-build --include-provenance
```

Exports are local portable packages. They are not uploaded, published, sold,
or licensed by the export command.

## Context Dock Architectural Constraints

- Use this repository and the current HII/AII runtime.
- Use the selected Markdown vault for authored knowledge and `~/.hii/hii.db` for canonical Context Dock indexing and operational state.
- Do not create another daemon, runtime, database, or product repository.
- Use SQLite FTS5 and deterministic retrieval before embeddings.
- Keep user source files in place.
- Preserve path, line/page, freshness, hash/revision, and selection provenance.
- Keep source transmission visible and user-controlled.
- Exclude secrets from context packs, traces, receipts, and logs.
- Expose bounded MCP tools; do not expose general shell execution.
- Keep source-file mutation outside the Context Dock MCP server.

## Development

```sh
npm install
npm run dev
```

The primary app uses SvelteKit 5 and Vite with a Tauri desktop shell. Legacy
Next route modules remain temporarily behind compatibility adapters while the
parity migration finishes. Local runtime state belongs under `~/.hii`;
repo-local `.hii` files that remain are migration debt and must not be
multiplied.

Vitest is the fast feedback layer for unit and component contracts:

```sh
npm run test:watch  # local Vite-powered watch loop
npm run ci:fast     # typecheck + one-shot Vitest suite
npm run ci:full     # fast gate + HII smoke contracts + production build
```

Vite now powers development, Vitest, and the SvelteKit production build. GitHub
CI runs the fast gate first, then starts the production build only after the
fast lane passes.

Build the standalone macOS application with:

```sh
npm run build:tauri
```

The resulting `src-tauri/target/release/bundle/macos/HII.app` contains its own
SvelteKit adapter-node server, local terminal websocket gateway, and Node
runtime. It reads user-owned state from `~/.hii` and does not require the source
repository to launch. Because the web runtime is embedded, source commits do
not update an existing `.app`; rebuild and restart the bundle whenever shipped
UI, server code, public assets, or native resources change.

## Verification

```sh
npm run ci:fast
hii check
npm run hii:sdk:check
npm run hii:skills:check
npm run hii:knowledge:check
npm run hii:windows:check
npm run hii:workspace:check
npm run build
npm run build:tauri
hii health --text
hii caps show
```

Report exact failures and unverified behavior. Do not treat a successful exit
code as sufficient when behavior can be exercised directly.

## Shipping Boundary

`hii ship` means local validation and a local commit only. It may stage broad
worktree changes, so inspect ownership first.

`hii ship --push` requires explicit approval. Publishing, uploading, payments,
sales, outreach, deletion, secret export, and other irreversible or external
actions always require separate authority.

## Required Receipt

Every completed task ends with:

```text
Done:
Verified:
Not Verified:
Proof:
Risk:
Next Command:
```
