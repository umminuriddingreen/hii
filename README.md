# HII — Human Information Interface

HII is a local-first CLI and control plane for verified agent work. It gives
people one owner-operated path for turning intent,
source-linked knowledge, tools, files, machines, and memory into work that can
be reviewed, proved, and reused.

HII is not another AI chat UI and it is not an autonomous system that silently
owns the user's state. The user owns the workspace and final decisions. Agents
propose, annotate, execute within explicit bounds, and return evidence.

HII's coordination, policy, execution, capability, and proof systems are
internal HII runtime modules. The project is CLI-first for now: every important
operation should work through `hii` before it is promoted into web, desktop,
Notch, Browser, Create, or spatial workspace views.

The durable product loop is:

```text
human intent
→ source-linked context
→ bounded agent work
→ proof and verification
→ durable receipt
→ reviewed reusable capability
```

Read [the HII master context](docs/HII_AII_MASTER_CONTEXT.md) and
[ADR 004: CLI-First HII Runtime](docs/decisions/004-cli-first-hii-runtime.md)
before making product or architecture changes.

## Product Shape

HII brings the loop together as one spatial workspace:

- **Notch:** the persistent macOS edge for intent, active state, approvals, and returning to work.
- **Browser:** a quiet local retrieval mode that turns pages and selections into source-linked context.
- **Create:** a visual workflow mode for versioned capabilities, reviewed execution, and verified artifacts.
- **Sidebar:** durable projects, sources, memory, capabilities, and recent work.
- **Canvas:** the active 2D workspace where people arrange knowledge and work;
  3D may become another view over the same state, not a separate product model.
- **`⌘I` palette:** contextual actions for the selected project, source, node,
  or result.
- **Governed HII nodes:** visible units for context, permissions, agent work,
  artifacts, verification, and receipts.
- **Context Dock:** the source-aware knowledge layer that makes selected
  material useful to agents without losing provenance.
- **HII runtime:** bounded coordination and execution behind the CLI contract.

External apps, models, local runtimes, and specialist systems such as Termite
are capabilities HII coordinates. HII should not recreate every tool it can
govern.

Notch, Browser, Create, and the spatial Workspace are views over the same HII
project state and proof history. See [Notch, Browser, and Create](docs/NOTCH_BROWSER_CREATE.md).

The CLI is the product center for now. Visual surfaces should feel bright,
spatial, calm, and playful when they return to the foreground, but they are
projections over the same CLI-owned state and proof history.

## Privacy and Human Authority

The governing rule is: **my computer decides what leaves my computer**.

HII keeps source selection, outbound context, redaction, and approval visible.
Before external transmission, a user should be able to preview what will leave,
remove sensitive material, approve or deny it, and retain a receipt of the
decision. Sharing and export mean user-approved workflow traces, decisions, and
verified capabilities—not an opaque reasoning stream or an automatic upload of
private project state.

## Documentation

HII compiles its repository documentation into a source-linked web manual at
`/docs`. Run `npm run dev`, then open:

```text
http://127.0.0.1:5173/docs
```

The web manual reads the Markdown files in this repository at request time.
Those source files remain canonical; the web surface adds navigation,
provenance, status, readable code and tables, and stable document URLs.

## Current Product Decision

The active wedge is **HII Knowledge Workspace**, built on the Context Dock
foundation. It is the first complete proof of the broader HII control plane,
not a separate product identity:

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

Authored knowledge lives canonically in the local HII instance at
`~/.hii/hii.db`. Complete Obsidian or Markdown vaults can be hash-locked,
imported without source mutation, verified, rolled back, and exported back to
portable files. HII-managed assets live under `~/.hii/knowledge/`; externally
linked assets retain their paths and hashes. Project System Maps are
source-linked views over the same knowledge—not a separate diagram product or
chat transcript.

The knowledge and Context Dock loop is not yet complete. Existing boards,
console, daemon, jobs, capabilities, bridge, packs, link, credit, exchange,
and Termite surfaces are implementation history or substrate. They are not
permission to widen Context Dock 0.1 into a marketplace, AI chat product,
decentralized compute network, geometry platform, or personal-data harvester.

## Build Now / Build Next / Later

### Build now

- Close the local Knowledge → Agent → Receipt loop.
- Make project selection, source permissions, provenance, and outbound context
  understandable before work begins.
- Provide reliable notes, links, backlinks, tags, search, graph, history,
  import/export, and recovery on the canonical local store.
- Deliver bounded agent actions with visible verification, artifacts, and
  receipts.
- Prove one useful workflow outside HII development repeatedly, measuring
  prompting burden, intervention, elapsed time, reliability, and proof quality.

### Build next

- Unify the sidebar, canvas, `⌘I` palette, and governed HII nodes around the
  same workspace state.
- Promote repeatable work into reviewed capabilities only when receipts prove
  that later runs are genuinely easier and reliable.
- Deepen specialist capability integrations without weakening permissions,
  provenance, or the user's ownership of final state.
- Evolve the canvas from a strong 2D workspace toward optional spatial and 3D
  views over the same durable model.

### Later

- Collaboration, exchange, marketplace, credits, cloud sync, and broader
  network effects remain deferred until the local governed loop is dependable.
- A first-party browser engine, generalized geometry platform, and autonomous
  publishing are separate product decisions, not implied by the current
  substrate.
- No future surface may bypass preview, permission, proof, or user approval
  merely because the underlying agent or model can act.

## HII Runtime Boundary

- **HII CLI** owns the primary product loop, context review, projects,
  approvals, verification, receipts, agent lifecycle commands, capabilities,
  policy, managed execution, handoffs, proof collection, runtime configuration,
  and skill promotion.
- **Shared runtime** under `~/.hii` is the durable local state substrate.
- **Models** are replaceable reasoning engines; they do not own permissions or
  durable project truth.

The visual interface and desktop application are called **HII** when they are
used, but they are projections over CLI-owned HII state. There is no separately
named interface or execution product.

The dependency direction is:

```text
HII CLI/runtime → records governed state → ~/.hii ← HII views read and present state
```

## Current Coordinates

```text
Repository:       current source checkout
Runtime:          ~/.hii
Launcher:         resolved by `command -v hii`
Launcher source:  <repository>/scripts/hii-launcher.sh
Context database: ~/.hii/hii.db
Knowledge store:  ~/.hii/hii.db + ~/.hii/knowledge
Runtime debt:     <repository>/aii (temporary internal HII runtime paths)
Capability source:<repository>/aii/capabilities/registry.json (migration target)
```

`~/hii-old` is legacy evidence only if present. It is never a current
execution or validation target.

## Agent Bootstrap

```sh
hii home --json
hii agents guide
hii og status
hii caps show
git status --short
```

Live command, repository, process, and runtime evidence wins over cached
summaries.

## Terminal Control Plane

The `hii` command is the fast Rust workspace agent for the governed HII loop.
Bare `hii` opens an ongoing conversation with session memory and a live
stream of the local model's provider-supplied thinking, response text, tool
actions, and results. A quoted intent or `hii run` uses the same visible stream
for explicit work.

```sh
hii
hii "fix the failing tests and prove the result"
hii run --review "ship the smallest verified patch"
hii status
hii doctor
hii models
hii proof

# Existing HII contracts remain available during the Rust migration.
hii home --json       # compact first read for agents
hii agents guide      # shared HII-first contract for installed agents
hii context --json    # full repo/runtime/capability detail when needed
hii caps show
hii task "Add source provenance to the import receipt" --coordinate /path/to/project
hii work
```

The default workhorse is local `qwen3.6:35b-mlx`. There is no model/tool-step
ceiling by default: HII continues until the model finishes or the operator
interrupts with Esc/Ctrl-C. `--max-steps N` adds a ceiling only when explicitly
requested. Typed read/search/write/shell/verify tools remain inside the
workspace, and events plus receipts persist under `~/.hii/runs/cli/`.

Conversation events are stored under `~/.hii/conversations/cli/`; when a turn
uses workspace tools, its proof remains available through `hii proof`.
Recognizable file deletion always pauses for live yes/no approval—even under
YOLO authority—and is refused on non-interactive MCP channels. `hii run
--verbose` adds the full contract and receipt coordinates to the live stream.

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
  --coordinate /path/to/project \
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

- Use this repository and the current HII CLI/runtime.
- Use `~/.hii/hii.db` for canonical authored knowledge, Context Dock indexing, and operational state; preserve imported vaults as immutable provenance and portable export sources.
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

Build the standalone application on its target operating system with:

```sh
npm run build:tauri:mac      # macOS .app
npm run build:tauri:windows  # Windows NSIS setup.exe
```

The resulting app contains its own
SvelteKit adapter-node server, local terminal websocket gateway, and Node
runtime. It reads user-owned state from `~/.hii` and does not require the source
repository to launch. Because the web runtime is embedded, source commits do
not update an existing `.app`; rebuild and restart the bundle whenever shipped
UI, server code, public assets, or native resources change.

Windows packages are built and installed on a native Windows runner by
`.github/workflows/windows-packaged-app.yml`; the gate must prove the installed
app, local server, and embedded HII runtime start/stop before its NSIS artifact
is used.

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
npm run ci:release-candidate
hii health --text
hii caps show
```

`ci:release-candidate` is the slower macOS-only local release gate. It runs the
full product and CLI checks, rebuilds `HII.app`, copies the app outside the
repository, and verifies clean-user startup, receipt persistence across a
reinstall-shaped restart, corrupt-workspace recovery, and strict code-sign
integrity. It does not publish, notarize, or upload the app.

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
