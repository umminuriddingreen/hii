# HII — Human Information Interface

HII is a local-first, user-owned interface for source-linked context and
verified agent work.

The human-facing center is a spatial workspace where files, notes, terminals,
browser captures, tasks, runs, artifacts, and receipts can be handled as durable
objects. The runtime center is the `hii` CLI, which owns bounded execution,
authority, verification, proof, and the contracts projected into the desktop
and web surfaces.

HII is not an operating system, a generic chat wrapper, or an autonomous owner
of the user's state. Models are replaceable reasoning engines. The user owns
the workspace, grants consequential authority, and makes the final decision.

```text
human intent
→ approved, source-linked context
→ bounded capability
→ visible work
→ verification and proof
→ durable result and receipt
```

The product direction is defined by
[the HII master context](docs/HII_AII_MASTER_CONTEXT.md),
[ADR 004: CLI-First HII Runtime](docs/decisions/004-cli-first-hii-runtime.md),
and
[ADR 005: One Surface over the User's Systems and Data](docs/decisions/005-one-surface-machine-fabric.md).

## Reality Snapshot

This is the verified state of the active checkout on **2026-08-27 EDT**. It is
a development snapshot, not a release or deployment claim.

| Surface | What is alive or present now | Current boundary |
| --- | --- | --- |
| Source checkout | `/Users/ummi/hii`, branch `main` | The worktree has unrelated in-progress changes; inspect before staging or shipping. |
| Installed CLI | `hii 0.1.0` at `/Users/ummi/bin/hii`, resolving the release binary in this checkout | The installed binary must be rebuilt before source-only CLI changes become launcher-visible. |
| Local model runtime | Ollama is reachable; five models are installed; `qwen3.6:35b-mlx` is configured as the default | A normal run has a 60-step default ceiling unless `--max-steps 0` is explicitly chosen. |
| Local HII state | `~/.hii` exists; `hii.db`, knowledge files, conversations, runs, receipts, traces, board state, and 128 indexed skills are present | Runtime records prove only HII-instrumented work, not all activity on the host. |
| Supervisor | `hiid` state exists but the supervisor is stopped; there are no live HII executors | Managed jobs are not continuously running just because their records exist. |
| Spatial app | Next.js/React workspace source, the Rust core, and the Tauri desktop shell exist | No HII web or desktop development server was listening during this snapshot; the UI was not visually re-exercised. |
| macOS Space control | Native observation and bounded app/window actions report ready | The current snapshot is limited at the login window; AeroSpace workspace and tiling features are offline. |
| Machine fabric | Protocol, identity/relay, macOS capture, and Windows receiver foundations exist in `fabric/` | The enrolled Windows machine is `pending-agent`; authenticated transport, remote input, presentation, transfer, and end-to-end convergence are not proven. |
| Cloud-backed flows | Supabase, R2, Stripe, link publishing, credits, and exchange code paths exist | Required environment variables are absent in the inspected shell, so those flows are not live-verified here. |

Refresh this snapshot from executable state instead of trusting this table:

```sh
hii home --json
hii doctor
hii status
hii presence status --json
hii caps show
hii systems status --json
hii space health
hii space snapshot
git status --short
```

Live command, process, repository, and runtime evidence wins over README copy.

## What Exists Today

### 1. Rust CLI and local runtime

The installed `hii` command currently exposes an interactive local workspace
agent plus command families for:

- bounded runs, status, provider/model inspection, presence, streams, and
  receipts;
- terminals, applications, information capture, governed web work, and local
  system observation;
- boards, schedules, notifications, projects, skills, capabilities, and the
  operational graph;
- enrolled systems, local services, shares, and runtime projections;
- MCP tools and a minimal ACP handshake.

Start with:

```sh
hii
hii "finish one bounded task and prove it"
hii run --review "make the smallest verified change"
hii proof
```

The agent tool boundary includes scoped read, list, search, write, edit, shell,
verify, HTTP, MCP, context, information, board, schedule, system, object, and
bridge tools. The shell guard blocks known destructive patterns and paths
outside the selected workspace, but it is not an operating-system sandbox.
Publishing, pushing, spending, messaging, deletion, secret export, and access
expansion remain separate authority boundaries.

Run and conversation state is stored under `~/.hii`. Workspace runs emit events
and receipts that can be inspected with `hii proof`; an incomplete or aborted
receipt is not successful proof.

### 2. Spatial workspace

The desktop target renders `components/workspace/HiiRoot.tsx` inside a Tauri 2
shell. The current implementation includes:

- a pannable, zoomable, persisted canvas with named workspaces, revisioned
  writes, undo/redo, selection, duplication, deletion, frames, links, and
  recovery behavior;
- typed nodes for chat, intent, runs, notes, canvas text, ink, links, files,
  images, media, documents, CAD, 3D models, HTML, fonts, terminals, browsers,
  explorers, context, boards, frames, surfaces, apps, jobs, and sound fields;
- direct text, URL, and file paste/import paths;
- terminal, browser/information, and agent-run projections;
- source, run, artifact, proof, and receipt metadata on governed objects;
- local Spaces that reuse the same workspace object model for images, text,
  stickers, and drawings.

The web target currently renders a minimal account-access surface. The richer
workspace is the desktop target and is also reused by local Space routes. A
web login control is not evidence of connected production authentication.

### 3. Core, protocol, and adapters

`crates/hii-core` owns shared Rust contracts for workspace state, information,
operational objects, runtime events, authority, receipts, and projections.
`protocol/runtime/v1/runtime.schema.json` publishes the versioned runtime
schema. The Tauri commands and local development adapter bridge the workspace
to those contracts.

`hii mcp-serve` exposes the bounded HII tool surface over stdio. It is an agent
adapter over the local runtime, not the canonical canvas database, a remote
device transport, or proof that every visual action is agent-addressable.

### 4. Knowledge and Context Dock foundations

The repository and local runtime contain:

- a canonical SQLite database at `~/.hii/hii.db`;
- object-native knowledge, relations, search, history, import/export, and
  smoke-test paths;
- source-linked information capture and local browser retrieval;
- project context, provenance, context staging, and receipt contracts;
- MCP and workspace integration points.

The full Context Dock acceptance loop is not yet proven. A fresh packaged user
has not been shown, in this snapshot, to approve a project, inventory it,
compile and review a bounded source pack, deliver it to an agent, resume after
restart, inspect proof, and delete derived data end to end.

The current worktree also contains in-progress ContextPack integration between
canvas selection and agent start. Treat that as active development—not a
released capability—until its scoped tests, build, commit, and runtime exercise
are complete.

### 5. Machine fabric foundations

The machine-fabric source is deliberately split into bounded pieces:

- `fabric/protocol`: typed control messages and authority claims;
- `fabric/identity`: device, passkey, session, grant, and revocation records;
- `fabric/relay`: local relay state and delivery foundations;
- `fabric/macos-capture`: ScreenCaptureKit discovery and latest-frame capture;
- `fabric/windows-receiver`: bounded Windows frame/session and D3D11 receiver
  boundaries.

These are foundations, not a working cross-device product. There is currently
no proven secure transport binding the pieces, no verified physical iPhone
replica, no proven Mac-to-Windows frame presentation, and no proven remote
input, file transfer, localhost proxy, or compute-routing loop.

## Architecture

```text
selection + text + voice + direct manipulation
                       ↓
              typed bounded intent
                       ↓
        HII CLI/runtime authority contract
                       ↓
        local or authenticated executor
                       ↓
          artifact + verification + receipt
                       ↓
             durable workspace update
```

CLI-first means the CLI/runtime owns deterministic state, authority, execution,
verification, and receipts. It does not mean the terminal should dominate the
human experience.

The durable dependency direction is:

```text
HII CLI/runtime → records governed state → ~/.hii
HII views       ← read and present that state
```

Existing `aii/` paths are internal migration debt, not a second product or a
forward architecture. New surfaces must reuse HII state and proof rather than
create another daemon, database, workspace, or agent control plane.

## Privacy and Authority

The governing rule is: **my computer decides what leaves my computer**.

- Observation and planning are read-only by default.
- Consequential work requires declared authority and the appropriate preview or
  confirmation.
- Important context retains source and freshness information.
- Raw secrets do not belong in packs, traces, receipts, logs, or documentation.
- Localhost services are exposed individually, never wholesale.
- Device claims require a working transport, live executor, and returned
  evidence.
- Agents may propose changes; they do not silently define, publish, or overwrite
  the user's state.

## Development

Requirements vary by surface, but the active stack is Rust, Node.js, Next.js,
React, Vitest, Tauri 2, and Ollama.

```sh
npm install
hii doctor
```

Run the web access surface and its local development adapter:

```sh
npm run dev
```

Run the desktop-target Next.js surface on loopback port 3042:

```sh
npm run dev:desktop
```

Point an installed HII app at that server for live UI work, then return it to
the bundled UI when finished:

```sh
npm run ui:live
npm run ui:live:off
```

Build the active targets:

```sh
npm run build
npm run build:desktop
npm run build:tauri:mac
npm run build:tauri:windows
```

The desktop bundle embeds its web runtime and staged CLI. Source changes do not
update an existing application bundle; rebuild and restart it before making
packaged-runtime claims.

## Verification

Use the smallest relevant check while iterating, then broaden before release:

```sh
npm run check
npm run test
npm run cli:check
npm run ci:product
npm run build
```

The full local gates are:

```sh
npm run ci:fast
npm run ci:full
npm run ci:release-candidate
```

`ci:release-candidate` validates and packages locally. It does not publish,
notarize, upload, or prove another physical machine.

For CLI work, rebuild the release binary before testing the installed launcher:

```sh
npm run cli:build
hii --version
hii doctor
```

## Repository Map

```text
app/                  Next.js routes and web entrypoints
components/workspace/ primary spatial workspace
components/spaces/    local Space creation, hosting, and visitor surface
cli/                  Rust CLI, agent loop, tools, MCP/ACP, proof, and commands
crates/hii-core/       shared Rust runtime and object contracts
src-tauri/             macOS/Windows desktop shell and native bridges
protocol/              versioned runtime schema
fabric/                cross-device foundations; not an end-to-end fabric yet
lib/                   workspace, context, knowledge, and client adapters
scripts/               local development, smoke, packaging, and release gates
docs/                  product context, decisions, evidence, and historical plans
aii/                   temporary internal migration debt
```

Historical plans and prototypes may describe more than the active product. Use
the master context, accepted ADRs, live code, tests, processes, and runtime state
to resolve conflicts.

## Shipping Boundary

`hii ship` means local validation and a local commit. Because this checkout may
contain concurrent work, inspect the exact diff and stage only owned files.

`hii ship --push` requires explicit approval. Publishing, uploading, payments,
sales, outreach, deletion, secret export, and access expansion always require
separate authority.
