# HII Milestone Catalog and Roadmap

**Date:** 2026-08-13 · **Branch:** `release/new-user-ready` · **Version:** 0.1.0

## Where this stands

HII is 345 commits old. The first was 2026-06-28 — a Next.js spine that did
upload → pay → signed download → log. Forty-six days later it is a local-first
control plane for verified agent work, whose primary surface is a 29,402-line
Rust CLI with 319 passing tests.

The shape of the product changed twice in that window, and both turns are
recorded as accepted decisions rather than drift. It went from a web spine to a
spatial workspace to a CLI. ADR 004 (2026-08-11) made the last turn explicit:
the CLI is the product, and every other surface is a projection over
CLI-owned state until the core loop is boringly reliable.

```text
intent -> context -> bounded work -> verification -> receipt -> reusable capability
```

That loop is the whole thesis. Everything below is either an implementation of
it or a projection of it.

---

## What is built

### The Rust CLI — the product

44 source files, 29,402 lines, 319 tests. Version 0.1.0.

**Execution and bounds.** Runs are bounded in four independent dimensions —
tool steps (`--max-steps`), wall clock (`--deadline`), tokens
(`--token-budget`), and workspace (`--cwd`). Ctrl-C finalizes a partial receipt
rather than discarding the run. Authority envelopes and a live permission
boundary gate what a run may touch; plan mode is enforced, not advisory.

**Local model runtime.** Ollama and LM Studio clients with native streaming,
model evaluation consolidated into one path, per-provider routing modes
(`auto | local | private | best`), and a hosted-transmission contract of
`explicit-only` — nothing reaches Codex or Claude without an operator act.

**Interactive surface.** A raw-mode REPL with a Codex-style navigation grammar:
animated slash palette, visible steering composer, live thinking stream,
persistent session goals, side chat, undo/fork/teach, secure keymap profiles,
persistent signature themes, a native file explorer, and — as of today — an
inline type-to-filter picker for `/model`, `/theme`, `/thinking`, `/reasoning`
that matches the shipped Ollama CLI's selection experience.

**Governance.** Lifecycle hooks, MCP clients under ACLs, an isolated public-test
gateway, bounded conversation attachments, safe native web fetching, and an
intent pipe that compiles a goal into a capability + authority + execution +
proof plan before anything runs.

**Agent contract.** `tools-manifest`, `mcp-serve` (MCP over stdio) and
`acp-serve` (ACP handshake) expose the tool surface to other agents. Token-
efficient orientation through `hii home --brief` (~600 bytes) with `--json`
escalation.

**Proof.** `hii proof` inspects receipts; verification is named in the receipt;
`hii stream` watches the run stream continuously. Model calls are logged.

### Runtime capabilities

35 registered capabilities, the large majority `ready / first-party`. They span
terminal observation, bounded agent spawn, the operational object graph, the
kanban board, skill growth, registry scan and doctor, credits quoting, browser
link capture and retrieval, offline caching, the publish stream, the creative
canvas, the knowledge workspace, window state, config read/control, local cron,
Apple Calendar, system monitoring, Notch ambient intelligence, voice
interpretation, and the Create workflow.

Five are honestly marked `partial` and one `blocked` — the registry does not
flatter itself, which is the point of having one.

### Skills and learning

Skill lifecycle unified into one evidence-based path: `proposed → observed →
verified → trusted`. Registration stays proof-backed and operator-reviewed;
`hii skill report` writes receipts, `--repeatable` creates a draft only.
`hii find` searches every local capability HII already owns across registries.

### Surfaces (projections)

- **Web** — 41 Next.js routes, Cloudflare Worker deployment, R2-backed private
  CLI distribution with fail-closed download routes, Stripe credit billing spine
- **Desktop** — one Tauri codebase for macOS 13+ Apple Silicon and Windows
  10/11; the packaged app owns its local server and daemon and does not depend
  on the source checkout
- **Spatial workspace** — 51 Svelte components; governed scenes, spatial run
  streaming, asset viewers, contact-sheet reference review, artifact preview
- **Notch** — ambient live island, hover-open
- **Browser** — 3 extensions (Helium sync, Chrome link capture, stream MCP)
- **External** — 11 vendored projects including a browser, editor, agent harness
  benchmark, text-to-CAD, and computer use

### Decisions on record

| ADR | Date | Decision |
| --- | --- | --- |
| 001 | 2026-07-19 | Obsidian-class HII Knowledge Workspace on Context Dock |
| 002 | 2026-08-08 | Operational object graph |
| 003 | 2026-08-11 | Object-native memory workspace |
| 004 | 2026-08-11 | CLI-first HII runtime; AII retired as a product |

---

## The honest read

**What is real.** The CLI loop runs, bounds itself, and writes receipts. The
capability registry reflects reality including its own gaps. The packaged macOS
app passes an isolated proof. The test suite is meaningful — 319 Rust tests plus
89 test files on the JS side, and today they caught a live regression that had
silently resolved every machine's model profile to `noop`.

**What is not yet proven.** ADR 004 names the acceptance test and it has not
been passed: HII must repeatedly complete concrete *non-HII* tasks with less
re-prompting, inspectable proof, and durable receipts. Until then, by the
project's own standard, the additional surfaces are decoration.

**What is blocked on money and paperwork, not code.** Distribution signing is
unavailable on both platforms — no Apple Developer ID, no Authenticode
certificate. The download routes are implemented and the artifacts absent. This
is the gate between a working product and one anyone else can install.

**Migration debt.** `aii/` still holds 40 modules that ADR 004 designates as
migration targets, and `config/native-model-profiles.json` is still read by
`aii/daemon/hiid.mjs` rather than through a CLI-owned contract.

**Right now.** 11 commits sit unpushed on `release/new-user-ready`.

---

## Roadmap

Ordered by what unblocks what, not by appeal.

### Horizon 1 — Back up the work · days

The only thing standing between 46 days of work and a disk failure is a push.

- Push `release/new-user-ready` (11 commits, explicit approval required)
- Land the routing reconciliation captured as task `d72f8b3b`

**Exit:** origin matches local; no unpushed product work.

### Horizon 2 — Pass HII's own acceptance test · 2–4 weeks

This is the gate ADR 004 set, and nothing below it should start first.

- Pick three concrete external tasks with nothing to do with building HII
- Run each end to end: approved context pack → bounded CLI run → verification
  named in the receipt → receipt visible through `hii proof` → skill candidate
- Measure re-prompts per completed task and drive the number down
- Fix what the runs expose rather than what seems elegant

**Exit:** three external tasks completed on the loop, receipts to show for it,
and a re-prompt count trending down across attempts.

### Horizon 3 — One authoritative model router · 1–2 weeks

Deferred deliberately today; the design is settled, the inputs are not.

- Reconcile three competing model naming schemes: `config.rs::DEFAULT_MODEL`
  (`qwen3.6:35b-mlx`), the config's `Qwen/Qwen3.6:35b-a3b`, and what
  `ollama list` reports
- Build the router config-backed from `taskTiers`, never hardcoded in Rust
- Select on measured evaluations, not input length
- Never auto-escalate past the local tiers; hosted stays operator-invoked

**Exit:** one router, one source of truth, tier selection provable from
recorded evaluations.

### Horizon 4 — Retire the migration debt · 2–4 weeks

ADR 004's migration order, executed.

- Inventory `aii/` by live dependency and runtime value
- Move runtime contracts behind `hii agent | caps | skills | proof | context | work`
- Replace `aii/*` imports in scripts and server code
- Archive `aii/workstation` once its Apple-context ideas are migrated or
  explicitly rejected
- Bring `native-model-profiles.json` under a CLI-owned contract

**Exit:** no `aii/*` import outside the archive; the daemon reads CLI-owned state.

### Horizon 5 — Make it installable by someone else · gated on accounts

Code-complete already; this horizon is purchases and paperwork.

- Apple Developer ID + `notarytool` keychain profile → notarized macOS build
- Authenticode certificate through Actions secrets → signed NSIS installer with
  a verified chain
- Upload artifacts and SHA-256 manifests to R2; deploy; test each download from
  a separate machine

**Exit:** a person who is not the author installs HII without bypassing
Gatekeeper or SmartScreen.

### Horizon 6 — Promote the projections · after 2 and 5

Only once the loop is boringly reliable and the app is installable.

- Knowledge workspace end-to-end (ADR 001): notes, links, backlinks, tags, FTS5,
  graph, daily notes, history, trash/restore, import/export, provenance
- Live stream and personal world model per `docs/hii-live-stream-and-world-model.md`
- Web, Notch, Browser, Create rendered strictly from CLI-owned state

**Not now:** plugin marketplace, cloud sync, Creator Desk, credits expansion,
decentralized compute. The local loop earns those or they don't happen.

---

## The one-line version

The engine is built and honest about itself; it has not yet been asked to do
enough work that isn't its own, and nobody else can install it. Horizons 2 and 5
are the whole game.
