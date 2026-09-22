# HII Agent Guide

## Required Product Context

Before planning or modifying HII, read:

- `docs/HII_AII_MASTER_CONTEXT.md`
- `docs/business/structure.md`
- `docs/decisions/004-cli-first-hii-runtime.md`
- `docs/decisions/005-one-surface-machine-fabric.md`

These documents define the founder thesis, the CLI-first product direction,
current Context Dock product scope, architecture constraints, deferred roadmap,
trust model, and required agent behavior. Historical brainstorms do not
override the current product decision.

This repo is an active multi-agent worktree. Codex, Claude, HII workers, and the user may all be editing or generating artifacts at the same time.

## Mission

HII is a self-organizing system managed by agents and curated by the user. It is
the glue among the user's software, projects, creative disciplines, devices,
and own network, not a replacement operating system. Agents should be able to
operate the HII app end to end through the CLI-owned authority and shared
objects: inspect, act, verify, recover, and show receipts. Remove needless
manual handoffs for reversible local work. The user sets direction and judges
results in ordinary language; agents translate that direction into bounded
implementation and tests without requiring the user to know developer syntax.

When HII improves itself, create an isolated source worktree, preserve every
other checkout (including dirty worktrees), run checks, and keep source changes,
installed CLI releases, signed app updates, and live site deployments distinct.
Codex skills and memory may be reconciled into local HII memory with source
references; do not silently publish or account-sync that private context.

HII is one user-owned inference surface for systems and data across all of the
user's devices and networks, backed by a local-first control plane for verified
work.

The current product wedge is:

Selected object + text/voice intent -> bounded capability -> visible result -> proof -> durable object/receipt.

## Worktree Discipline

- Start with `hii home --json`, the compact machine-readable map of the current
  repo, work queue, capabilities, guardrails, and likely next actions.
- Deepen only when needed with `hii context --json`, `hii work --json`,
  `hii caps show`, or `hii og status`. The shared cross-agent contract is
  always available at `hii agents guide`.
- Set `HII_AGENT_ID` to your agent name. If `hii home --json` reports pending
  handoffs, read `hii agents inbox --for <agent>` and acknowledge incorporated
  messages. Use `hii agents send` for task, workspace, context, and proof
  handoffs to another local agent.
- Check `git status --short` and targeted diffs before editing.
- Do not reset, delete, format, or rewrite files outside your scoped task.
- Treat broad untracked folders such as `.claude/`, `.hermes/`, screenshots, and `life/` as possibly owned by another agent or the user.
- Discover the active checkout with `git rev-parse --show-toplevel` and inspect
  its branch, remotes, and dirty state. As of 2026-09-05 the working Mac checkout
  is `/Users/ummi/hii`; do not assume historical checkout paths are authoritative.
- Read `docs/records/2026-09-05-shared-main-handoff.md` for the Windows/Mac
  integration and outstanding verification. Run
  `node scripts/hii-source-update.mjs status` at session start for cached source
  currency. `check` explicitly fetches; `update` only fast-forwards a clean main.
  Never stash, discard, or commit another agent's work to unblock an update.
- Source rollback is distinct from app or data rollback. Follow
  `docs/hii-source-update.md`; never downgrade or restore a live database as a
  side effect of checking out older code. Do not force-push based on historical
  notes: compare the current remote ancestry first.
- Keep secrets reference-only. Never print raw token values or copy credential files into docs, logs, or commits.
- Complete work locally by default. Do not fetch, push, publish, upload, or call
  external services unless the user explicitly asks for that external action.
- Keep changes minimal and prefer small patches over rewrites.
- Read only the files needed for the current task.
- Do not restyle the whole app or rename product concepts unless explicitly asked.
- Do not claim something is verified unless a command or visible output proves it.
- If a command fails, report the failure and continue only when the next step is safe.
- If shell/tooling is blocked, stop and report instead of fighting it.
- For business, launch, offer, or client-workspace tasks, classify the work
  before building: Studio sells one outcome now; Product repeats proven
  workflows; Network waits for shared-object/account evidence; unsupported
  architecture goes to parked backlog.

## Current Product Direction

- HII is one user-owned inference surface for systems and data across all of
  the user's devices and networks. The spatial workspace, text, voice,
  selection, and direct manipulation are inputs to the same typed intent and
  object model.
- The Rust CLI is the primary runtime, authority, verification surface, and
  agent contract. The friendly terminal and canvas are primary human interfaces
  to the same objects; the terminal is not developer-only or a chat transcript.
- Do not introduce or revive AII as a separate product, brand, app, repo,
  daemon family, or planning track. Existing `aii/` code is legacy/internal HII
  runtime code until it is migrated behind CLI-owned modules and commands.
- Web, Tauri, Notch, Browser, Create, and spatial workspace surfaces are
  projections over CLI-owned HII state. They should not become the source of
  truth until the CLI loop is boringly reliable.
- Founder decision ADR 005 makes the integrated surface and governed machine
  fabric the product center. ADR 001's Knowledge Workspace and Context Dock are
  its durable context and memory layer, not a separate destination product.
- Build the direction as narrow verified slices: local typed objects and system
  observation first, then authenticated Mac/Windows transport for displays,
  files, services, input, and bounded jobs. Never claim a remote device or
  capability is available without working transport and a live executor.
- Do not confuse the machine fabric with a marketplace, cloud sync product,
  credits expansion, or decentralized compute network. It is a user-owned,
  explicitly authorized link among the user's own resources.
- Local terminal execution remains operator-controlled and local-only until a hardened remote runner exists.

## CLI Interaction Surfaces

The Rust CLI lives in `cli/` but builds into the workspace target, so the binary
is `target/debug/hii` at the repo root, not `cli/target/debug/hii`.

- Anything that ends in "choose one of these" uses `cli/src/picker.rs`
  (`picker::select`) rather than printing a table the operator has to retype
  from. Ollama's shipped picker is the parity bar.
- Interactive widgets draw **inline**, never `EnterAlternateScreen`, so terminal
  scrollback stays the record of what happened. `cli/src/file_explorer.rs` is the
  deliberate exception.
- Move the cursor with relative `\x1b[{n}A` plus per-row `\r\x1b[2K`, never
  save/restore: saved coordinates break once drawing scrolls at the viewport
  bottom. `cli/src/keyboard.rs::redraw` is the reference.
- Pad plain strings to width *before* painting them. Escape bytes occupy no
  columns, so a width applied to an already-painted string misaligns.
- Gate every interactive path on `picker::is_available()` (`HII_UI_LINE_MODE`
  unset plus stdin/stdout both TTYs) and keep the printed fallback so piped and
  scripted use is unchanged.
- Interactive selection is still proof-bearing work: a model switch through the
  picker emits `conversation.model_changed` with its source, because a run that
  quietly changed models is a run whose proof record lies.
- Prove TUI behavior with unit tests over the rendered frame and the emitted
  escape sequences. Do not drive the CLI through a pty to "see" it; that burns
  minutes and tokens for a weaker result.

## Model Routing

`config/native-model-profiles.json` is the only source of truth. It holds two
vocabularies that must never be merged: `tiers` is hardware sizing, selected
first-match by ascending `memoryGiBMax`, and `taskTiers` is task difficulty.
Giving a task tier a `memoryGiBMax` puts an unconditional `null` match ahead of
every size and silently resolves the whole machine to `noop`.

- Do not hardcode a routing table in Rust. A future router reads the config.
- The auto advisor (`conversation.rs::auto_advisor_suggestion`, Tab when no command completion is active)
  suggests hosted routes only: it waits for `y` and turns a hosted route into
  literal `/codex …` or `/claude …` text the operator runs. Interactive local
  routing may prefer the loaded model and use the configured local task tier 2
  for explicit deep work or failed actions. It never escalates to hosted work.
- Nothing may escalate to a hosted model on its own. `hostedTransmission` is
  `explicit-only`, and `/mode` promises that to the operator on every switch.

## Cost Discipline

Claude quota is the scarcest resource on this machine. Spend it on judgment,
synthesis, and code that ships.

- Cache aggressively: keep the conversation prefix stable, batch independent
  reads, and never re-read a file to verify an edit that already succeeded.
- Push bulk work down the stack in this order: shell/`rg`/`jq`, then a local
  model, then a background agent, then a foreground Claude turn. Anything over
  about a minute of tool time belongs to a background agent.
- Delegate bounded, independent work only. Synthesis, final validation,
  approvals, and every external action stay in the main thread.
- Orient with `hii home --brief` (~600 bytes) and escalate to `--json` (~7800)
  only when brief is genuinely not enough.

## Verification

- Use `hii health --text` and `hii caps show` as compatibility-safe agent
  entrypoints.
- The operator may keep terminal windows minimized. When a run completes or
  genuinely needs an operator response, send a source-attributed `hii notify
  send` event and leave the terminal session waiting; do not rely on terminal
  focus as the attention mechanism.
- For CLI work, run `cargo build` and `cargo test` from `cli/`.
- Use `npm run build` for app validation.
- Web changes are not done until they are live. After any change that alters
  what humaninformationinterface.com serves, run `npm run deploy` (build +
  `wrangler deploy`) without asking, then confirm the live site with `curl`
  before reporting. Do not leave the deploy as a manual step for the user;
  agents have dropped it repeatedly.
- `hii ship` for local typecheck + commit; `hii ship --push` is pre-approved.
  Reversibility is the standard here, as in the machine guide: act on anything
  easily undone, and confirm first only where reversal is impossible.
- For billing work, also verify `/credits`, `/api/credits/quote`, `/api/credits/account`, `/api/credits/checkout`, `/api/capabilities/jobs`, and `/api/stripe/webhook` behavior where possible.
- If a dev server is running, do not assume its `.next` cache survived `next build`; restart after build if routes become inconsistent.

## Required Final Report

After meaningful completed work, also record the receipt through
`hii skill report`. Mark repeatable work with `--repeatable`; this creates a
draft only. Registration remains proof-backed and operator-reviewed.

Done:
Verified:
Not Verified:
Proof:
Risk:
Next Command:
