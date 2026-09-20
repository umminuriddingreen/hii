# HII Systems Tree

**Audience:** Ummi, as founder and operator

**Purpose:** One map of what HII is, what we have built, how the pieces connect,
and where to look when the system feels too large.

**Canonical root:** `/Users/ummi/hii`

**Shared local state:** `~/.hii`

## Read this first

HII is one system, not a collection of products.

```text
HII = the place where you understand and direct work
AII = the machinery that governs and carries out agent work
~/.hii = the durable local state they share
Models and tools = replaceable capabilities used to do the work
```

The complete loop is:

```text
your intent
  -> approved source-linked context
  -> bounded agent work
  -> visible changes and artifacts
  -> verification
  -> receipt
  -> durable memory
  -> reusable capability
```

Status labels in this document:

- `[LIVE]` — running or directly usable on this Mac now.
- `[BUILT]` — implemented and tested, but not necessarily running right now.
- `[PARTIAL]` — real implementation exists, but an important part is incomplete.
- `[LATER]` — architectural direction, not a current product claim.

## The whole system

```text
HII — Human Information Interface
|
+-- 1. HUMAN-FACING HII                                  [LIVE]
|   |  What you see, touch, arrange, approve, and review.
|   |
|   +-- Spatial workspace
|   |   +-- notes, text, images, media, PDFs, CAD and 3D objects
|   |   +-- browser and terminal panes
|   |   +-- scenes, frames, stacks, search, layout and navigation
|   |   +-- intent objects linked to agent-run objects
|   |   `-- proof, receipt and provenance attached to the work
|   |
|   +-- Knowledge workspace
|   |   +-- Markdown notes and folders
|   |   +-- links, backlinks, tags, search and graph
|   |   +-- history, trash, restore, import and export
|   |   `-- Context Dock: choose what context an agent may use
|   |
|   +-- Work controls
|   |   +-- activation: choose agent, context, authority and goal
|   |   +-- boards: proposed, approved, active, blocked and done work
|   |   +-- console: agents, logs, runs and receipts
|   |   `-- approvals: the human boundary before consequential action
|   |
|   +-- SvelteKit application                            [LIVE]
|   |   `-- source: src/routes, src/lib, src/app.css
|   |
|   `-- Native macOS application                         [BUILT]
|       +-- Tauri shell
|       +-- native cursor command bar
|       +-- native browser child windows
|       `-- source: src-tauri
|
+-- 2. AII — AGENT INFORMATION INTERFACE                 [LIVE]
|   |  The policy, coordination and execution layer beneath HII.
|   |
|   +-- hiid supervisor
|   |   +-- starts and observes managed agent processes
|   |   +-- records ready, working, attention and offline state
|   |   +-- accepts bounded run intents
|   |   +-- streams redacted events and logs
|   |   `-- source: aii/daemon/hiid.mjs
|   |
|   +-- Capability registry
|   |   +-- declares what HII/AII can do
|   |   +-- records owner, runtime, visibility and trust level
|   |   +-- publishes a runtime copy for HII to render
|   |   `-- source: aii/capabilities
|   |
|   +-- Skill growth
|   |   +-- verified action receipt
|   |   +-- repeatable-work draft
|   |   +-- operator review
|   |   +-- registered reusable skill
|   |   `-- source: aii/skills and ~/.hii/skills
|   |
|   +-- Policy and planning
|   |   +-- authority and approval decisions
|   |   +-- consent-gated admin proposals
|   |   `-- source: aii/admin-agent
|   |
|   `-- AII Workstation                                  [PARTIAL]
|       `-- separate control surface for coding-agent operations
|
+-- 3. HII CLI — DIRECT AGENT ENGINE                     [LIVE]
|   |  The `hii` command: the fastest path from a goal to verified work.
|   |
|   +-- Rust workspace agent
|   |   +-- contract: goal, authority, done-when and verification
|   |   +-- context capsule: scoped project instructions and provenance
|   |   +-- model loop: local Ollama or LM Studio reasoning
|   |   +-- governed tools: read, search, edit, shell, verify, HTTP and MCP
|   |   +-- budgets: steps, wall clock, model call and stream idle
|   |   +-- cancellation: Ctrl-C, Esc, client or exhausted budget
|   |   +-- journal: one ordered event record for the run
|   |   `-- receipt: outcome, proof, artifacts, risk and next action
|   |
|   +-- Interactive terminal
|   |   +-- conversation, steering, queueing and interruption
|   |   +-- model, thinking, authority and permission controls
|   |   `-- managed-agent and proof inspection
|   |
|   +-- Compatibility command layer
|   |   +-- context, health, capabilities and operational graph
|   |   +-- daemon, jobs, boards, skills, space and shipping commands
|   |   `-- delegated today to scripts/hii-cli.mjs
|   |
|   +-- MCP
|   |   +-- governed downstream MCP clients              [BUILT]
|   |   `-- HII tool server over stdio                   [BUILT]
|   |
|   `-- ACP northbound agent protocol                    [PARTIAL]
|       +-- initialize and session creation work
|       `-- real prompt/run streaming remains to build
|
+-- 4. SHARED LOCAL RUNTIME — ~/.hii                     [LIVE]
|   |  Durable substrate. Processes may stop; this state remains.
|   |
|   +-- hii.db                 canonical structured knowledge/state
|   +-- workspace/             spatial layouts and workspace assets
|   +-- knowledge/             local Markdown knowledge tree
|   +-- config.json            AII-owned HII surface configuration
|   +-- capabilities.json      published capability registry
|   +-- daemon/                hiid status, instances, events and runs
|   +-- runs/cli/              CLI event logs and receipts
|   +-- receipts/              other durable action receipts
|   +-- board/                 append-only task state
|   +-- bridge/                inter-agent message exchange
|   +-- skills/                drafts, registered skills and exports
|   +-- artifacts/             outputs tied to work
|   +-- traces/ and logs/      operational evidence
|   +-- schedules/             local scheduled work
|   +-- browser/ and cache/    captured and offline-readable links
|   `-- archive/ and backups/  preserved prior state
|
+-- 5. REPLACEABLE WORKERS AND TOOLS
|   |
|   +-- Reasoning engines
|   |   +-- local models through Ollama or LM Studio      [LIVE]
|   |   +-- Codex CLI                                    [LIVE]
|   |   `-- Claude CLI                                   [LIVE]
|   |
|   +-- HII-native tools
|   |   +-- filesystem and exact editing
|   |   +-- shell and verification
|   |   +-- local HTTP and public-web reading
|   |   +-- boards, context, capabilities and bridge
|   |   `-- desktop/window control through AeroSpace     [PARTIAL]
|   |
|   `-- External capabilities
|       +-- HII Rhino managed work                       [PARTIAL]
|       +-- browser capture and offline link cache       [BUILT]
|       +-- Apple context tools                          [PARTIAL]
|       +-- Blender and third-party MCP sources          [PARTIAL]
|       `-- future machines/runners                      [LATER]
|
+-- 6. PROOF, TRUST AND GOVERNANCE
|   |
|   +-- Human authority
|   |   +-- read-only
|   |   +-- workspace
|   |   +-- external preview
|   |   +-- external commit
|   |   `-- yolo, only when explicitly selected
|   |
|   +-- Context boundary
|   |   +-- named sources
|   |   +-- provenance and fingerprints
|   |   `-- approved context follows the run
|   |
|   +-- Execution boundary
|   |   +-- tool policy and destructive-action checks
|   |   +-- time and step budgets
|   |   `-- current shell guard is policy, not an OS sandbox [PARTIAL]
|   |
|   +-- Proof boundary
|   |   +-- a mutation invalidates earlier verification
|   |   +-- final completion requires fresh passing proof
|   |   `-- receipts remain inspectable after the run
|   |
|   `-- Publication boundary
|       +-- local completion and commits are normal
|       `-- push, deploy, publish, spend and message need explicit authority
|
`-- 7. FUTURE SYSTEM DIRECTIONS                           [LATER]
    |
    +-- hardened remote runner and multi-machine execution
    +-- complete ACP-driven HII agent sessions
    +-- one shared engine for CLI, terminal, ACP and managed runs
    +-- richer reusable capability packs
    +-- fabrication, music and creative-production capabilities
    `-- broader AII fleet coordination
```

## Follow one piece of work

```text
1. You create or select information in HII.
2. Context Dock turns that selection into an explicit context boundary.
3. You state the intent and approve the authority boundary.
4. HII writes the intent into the shared runtime.
5. AII or the Rust CLI starts a bounded agent run.
6. The model reasons; governed tools inspect or change the workspace.
7. Every meaningful event enters the run journal.
8. Any new mutation invalidates old proof.
9. A fresh verification command or acceptance check runs.
10. HII records the outcome, artifacts, proof, risk and next action in a receipt.
11. The workspace presents the result beside its originating context.
12. Repeated verified work may become a draft skill for your review.
```

## The ownership rule

```text
You
  own intent, meaning, approval and final judgment.

HII
  owns human understanding, spatial context, controls and review surfaces.

AII
  owns agent lifecycle, policy, execution coordination and capability state.

~/.hii
  owns durable local truth shared between processes.

Models
  reason, but do not own authority or system truth.

Tools
  act only through the authority and scope they are given.
```

## Where to look

| Question | First coordinate |
|---|---|
| What is HII supposed to be? | `docs/HII_AII_MASTER_CONTEXT.md` |
| What belongs to HII versus AII? | `docs/aii-hii-boundary.md` |
| What is running right now? | `hii health --text` and `hii daemon status` |
| What can the system do? | `hii caps show` |
| What should an agent inspect first? | `hii context --json` |
| What is the likely next path? | `hii og status` |
| Where is the visible application? | `src/routes`, `src/lib`, `src-tauri` |
| Where is agent coordination? | `aii/` |
| Where is the direct agent engine? | `cli/` |
| Where is durable local state? | `~/.hii` |
| Where is a CLI run’s evidence? | `~/.hii/runs/cli/<run-id>/` |
| How do I inspect the latest proof? | `hii proof` |
| What work is active? | `hii board` and `hii jobs` |

## What is core versus extension

The core is deliberately small:

```text
spatial human workspace
  + source-linked context
  + bounded agent execution
  + visible artifacts
  + fresh verification
  + durable receipts
```

HII Rhino, browser capture, desktop control, music, trading experiments, public
streams, commerce, and future machine runners are capabilities or experiments.
They are not separate HII products and they should not obscure the core loop.

## Current live snapshot

At the time this tree was written:

- Repository: `/Users/ummi/hii`
- Branch: `feat/cli-harness-hardening`
- `hiid`: running with `reversible-local` autonomy
- Rust CLI gate: 176 tests passing with strict Clippy
- Deterministic agent-harness regression: 7 of 7 passing
- HII/AII shared runtime: `~/.hii`
- Important unfinished architecture: shared CLI/terminal engine, real execution
  isolation, complete ACP prompt sessions, and trusted agent configuration

This snapshot will drift. The tree above describes the intended stable system;
the commands in “Where to look” reveal current operational truth.
