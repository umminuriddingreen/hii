# HII Master Context

**Founder:** Ummi Nuriddin Green  
**Status:** Founder-level product and architecture context  
**Version:** 1.2
**Date:** 2026-08-18

This document gives implementation agents one coherent account of what HII
means, what is being shipped now, what belongs later, and how work must be
performed. It prevents product drift, architecture drift, scope explosion, and
truth fragmentation.

**Current override, 2026-08-11:** ADR 004 makes HII CLI-first. AII is no
longer a separate product, brand, app, repo, or planning track. Existing `aii/`
paths are internal HII runtime migration debt until moved behind CLI-owned
modules and commands.

The cleanup is not primarily a rename. HII must first make one boring, fast,
receipt-backed CLI loop excellent: intent, approved context, bounded work,
verification, saved receipt, and repeatable capability. If that loop cannot
repeatedly complete concrete external tasks with less prompting and clear proof,
new or expanded surfaces are still decoration.

**Cross-chat synthesis, 2026-08-18:** The founder-level human experience and
the CLI-first implementation decision are complementary, not competing. HII is
personal intelligence made spatial: the canvas and durable objects are the
shared world, models supply replaceable cognition, and the CLI/runtime supplies
deterministic hands, authority, verification, and receipts. People should work
through direct manipulation, selection, speech, typing, and a finite interaction
grammar—not be required to think like the CLI. See
[`records/2026-08-18-cross-chat-hii-synthesis.md`](records/2026-08-18-cross-chat-hii-synthesis.md)
for the consolidated product direction, interaction model, web/information
model, provider strategy, practice structure, sequencing, and evidence boundary.

**Founder decision, 2026-08-18:** ADR 005 makes HII one user-owned inference
surface for systems and data across all of the user's devices and networks. The
canvas/workspace is the human-facing product center; the CLI remains the
deterministic runtime and authority boundary. The Knowledge Workspace and
Context Dock become the durable context and memory foundation for this surface.
The Mac/Windows machine fabric is a primary product direction, but it is not
implemented or verified merely because the direction is documented.

## Authority and use

Agents must distinguish four levels of truth:

1. **Founder thesis** explains why HII exists and protects its direction.
2. **System architecture** defines the HII CLI/runtime boundary and operating loop.
3. **Current product decision** defines the one-surface direction and the next
   narrow proof; Context Dock remains the local context and memory foundation.
4. **Future ecosystem** preserves Workstation, Foundry, Interform, commerce,
   fabrication, and personal intelligence as roadmap context.

When sources conflict, use this order:

1. Safety and explicit system guardrails.
2. Ummi's current instruction.
3. Scoped `AGENTS.md`, then root `AGENTS.md`.
4. Accepted architecture decisions and this master context.
5. Live code, schemas, tests, processes, and runtime state.
6. Current README and release plan.
7. Historical plans and brainstorming.
8. Mock UI, stale CLI help, and speculative marketing copy.

Report material conflicts. Do not silently invent a compromise.

## Canonical definition

**HII means Human Information Interface.** HII is personal intelligence made
spatial: a local-first, user-owned environment that lets people work directly
with durable information, tools, projects, and artifacts while models help
perceive, connect, transform, and act within explicit authority.

HII turns intent into verified work across information, tools, files, machines,
memory, and reusable capabilities. It is an information-model interface first:
pages, files, images, people, claims, questions, relationships, jobs, and
artifacts become source-backed objects that can be understood, manipulated,
connected, revised, and put to work without losing provenance.

HII's agent-facing coordination, policy, execution, capability publication,
agent lifecycle management, action governance, and proof recording are internal
HII runtime responsibilities. They should be operated through the CLI first.

The canonical loop is:

```text
human intent
→ approved, source-linked context
→ bounded work
→ governed capability execution
→ logs, artifacts, and tests
→ verification
→ inspectable receipt
→ durable project memory
→ reusable capability
```

HII is not a chatbot, model wrapper, terminal skin, marketplace, or collection
of unrelated tools. Internally, the sharp metaphor is a **control plane for
artificial labor**: it gives agents assignments, context, boundaries, tools,
status, proof, review, memory, and handoffs.

The equally important human-facing metaphor is:

```text
canvas and objects = shared world
models             = cognition
CLI/runtime        = deterministic hands
human              = intent, taste, authority, and final judgment
```

Chat remains available, but it is one gesture among pointing, selecting,
dragging, drawing, typing, speaking, grouping, revising, and approving.

## The three scales of HII

### HII as a practice

HII is Ummi's multidisciplinary design and technology practice exploring how
physical, digital, and cognitive environments can expand human capability and
help ideas become reality. Architecture, software, AI, products, construction,
fabrication, education, memory, business systems, and civic institutions are
different materials for designing environments in which intelligence and
coordinated action can emerge.

### HII as platform architecture

At the platform level, HII is the operating architecture for:

```text
context → assignment → execution → observation → verification → memory → repeatability
```

HII makes state understandable and controllable while making agent work bounded,
observable, policy-aware, and repeatable. The shared runtime preserves durable
state and proof while models remain replaceable reasoning engines.

### HII as the product being shipped now

The product is **one user-owned inference surface for systems and data across
all of the user's devices and networks**. Its active human-facing expression is
the spatial HII workspace:

> Point at, select, speak to, type to, arrange, and act on the user's digital
> world as durable objects—without hiding authority, provenance, or proof.

The Knowledge Workspace and Context Dock remain the first local proof and the
durable context/memory layer:

> Build knowledge once. HII keeps it linked, source-aware, agent-ready, and
> accountable.

ADR 005 extends, rather than replaces, ADRs 001–004. It authorizes a governed
machine fabric among the user's own devices; it does not authorize a separate
runtime, cloud-first sync, marketplace, or unbounded remote access.

## Ummi's central goal

Ummi's biggest problem is not idea generation. It is the distance between an
idea and a finished, verified, creatively or economically useful artifact.

The central goal is:

> **Reduce the distance between thought and executed artifact.**

HII should transform:

```text
human intent
→ structured context
→ agent-executable work
→ finished and verified output
→ product, service, revenue, reputation, learning, or infrastructure
```

It should help Ummi capture ideas without making every idea active, stop
re-explaining project history, preserve why decisions were made, coordinate
agents as workers, review evidence before trusting completion, maintain
continuity across machines and conversations, and turn repeated success into
reusable capability.

The ideal daily question is:

> What am I doing, why does it matter, what is blocked, what proof exists, and
> what is the next executable action?

## HII CLI/runtime boundary

### CLI-first does not mean terminal-first for humans

ADR 004 assigns ownership of state, policy, execution, verification, and agent
contracts to the Rust CLI/runtime. It does not require the human to formulate
their work as commands.

The intended dependency is:

```text
human behavior and expressed intent
→ perception and evidence-backed intent inference
→ proposed bounded action
→ CLI-owned capability and authority contract
→ deterministic execution
→ verified result and receipt
→ shared environment update
```

Inference may be probabilistic. The boundary where the world changes must be
deterministic and inspectable. The human-facing grammar should remain finite:
**Look · Do · Delegate**, with preview or approval before consequence and proof
after consequence.

### HII owns the whole product direction

HII owns the CLI, Next.js interface, Tauri desktop shell, projects and sources,
context-pack review, boards, spatial workspace, feed, activity history,
terminal surfaces, approvals, verification views, receipts, agent lifecycle,
capabilities, policy, managed execution, handoffs, proof collection, runtime
configuration, and skill promotion.

The spatial workspace is the primary human-facing product surface. The CLI is
the primary runtime, authority, verification, and agent-contract surface.
Visual surfaces are named **HII** when they are used and project CLI-owned HII
state and proof history.

Do not expand product surfaces until the CLI loop is strong enough to finish
useful work outside HII development. Web, Tauri, Notch, Browser, Create, and
spatial workspace work must either expose existing CLI-owned state or remove
friction from the intent-to-receipt loop; they must not become parallel product
tracks.

HII answers:

- What does the system know, and where did it come from?
- What work is active and what is proposed?
- What actually happened?
- What evidence exists?
- What needs approval?
- What happens next?

### Shared runtime

HII records explicit state under `~/.hii`:

```text
~/.hii/
├── config
├── capabilities
├── hii.db
├── board
├── og
├── loop
├── bridge
├── daemon
├── runs
├── traces
├── artifacts
├── receipts
└── skills
```

The intended dependency is:

```text
HII CLI/runtime → records configuration, capabilities, events, and execution state
                → shared runtime
HII views       ← read and present understandable state
```

Typed contracts, APIs, database records, files, capabilities, and events form
the boundary between CLI-owned runtime authority and optional visual views.

### Models, agents, and tools

```text
Model   = replaceable reasoning engine
Agent   = model + role + task + tools + limits
HII CLI = human understanding + control + review + policy + coordination + execution management
Runtime = durable state + context + evidence
Tool    = bounded action with declared inputs, outputs, and side effects
```

Long-term value comes from context, trust, workflow memory, and capability
compounding—not dependency on one model vendor.

## Canonical operating loop

Every serious workflow should map to:

1. Capture human intent.
2. Resolve project and scope.
3. Find source-linked context.
4. Create a bounded task.
5. Identify allowed capabilities.
6. Determine required approval.
7. Execute through an agent, tool, machine, or human.
8. Record progress and events.
9. Collect logs, artifacts, and tests.
10. Verify against acceptance criteria.
11. Produce a final receipt.
12. Update decisions and project memory.
13. Promote repeated verified success into reusable capability.
14. Publish, deliver, fabricate, or monetize only when authorized.

Context Dock owns the before-work context layer. HII runtime owns the
during-work governance layer. Receipts, memory, and skills close the after-work
layer.

## Current product: one inference surface on a governed machine fabric

### User outcome

A user should be able to:

1. Install and launch HII without using a terminal.
2. See local and connected systems, files, services, displays, applications,
   agents, and results as typed, source-identified objects.
3. Select those objects and express intent through direct manipulation, text,
   or voice without rebuilding context in a long prompt.
4. See exactly what HII may observe, what it may change, which device would act,
   what data would cross a link, and what is excluded.
5. Preview consequential work, authorize it at the right boundary, and receive
   live state plus proof from the actual executor.
6. Move frames, files, clipboard data, explicit services, and bounded jobs over
   authenticated user-owned links while preserving provenance.
7. Record decisions, files changed, verification, blockers, and next action.
8. Resume later without reconstructing project or machine understanding.
9. Create and edit durable workspace memory as typed objects with folders or
    collections, tags, links/backlinks, graph navigation, daily surfaces,
    history, and local Markdown/JSON export.
10. Let verified work become linked object memory and reusable capability.

### P0 capabilities

- Project or selected-folder onboarding.
- Visible approved roots, source types, and exclusions.
- Deterministic file, format, size, date, Git, and extraction inventory.
- Markdown, text, code, config, PDF text, image metadata, and Git extraction.
- Source-linked local search.
- Task-specific context compilation under a declared budget.
- Review, preview, pin, add, remove, exclude, and export controls.
- Bounded MCP read tools and explicit HII-state recording tools.
- Activity receipts for reads, results, verification, failures, and next action.
- Restart persistence and an installable macOS application.
- Visible privacy and external-transmission boundaries.
- Obsidian/Notion-class local knowledge work over object-native memory:
  notes, decisions, tasks, receipts, skills, links/backlinks, tags, FTS5
  search, graph navigation, daily surfaces, history, trash/restore, and
  Markdown/JSON import/export.

### Hard architecture decisions

- Use `/Users/ummi/hii`; do not create a parallel product repository.
- Use the existing HII CLI/runtime; do not create another daemon.
- Use the local HII instance and `~/.hii/hii.db` as authority for authored
  memory objects, typed knowledge, indexing, and the operational ledger.
- Import complete user-approved vaults through hash-locked, non-mutating batches and preserve portable Markdown export so HII authority never becomes data lock-in.
- Do not revive obsolete parallel databases.
- Use SQLite FTS5 and deterministic retrieval before embeddings.
- Let each asset import explicitly copy into HII-managed content-addressed storage or preserve the user file in place; store references, metadata, extracted text, hashes, and provenance.
- Use MCP as the agent integration contract.
- Require a source path and line/page range for important context.
- Make source transmission explicit and visible.
- Keep source-file mutation outside the Context Dock server.
- Never place raw secrets in context packs, traces, receipts, or logs.

### Context data model

The canonical context and memory entities are:

- `context_projects`
- `context_sources`
- `context_documents`
- `context_chunks`
- `context_facts`
- `context_relations`
- `context_packs`
- `context_pack_items`
- `context_decisions`
- `context_receipts`
- `context_scan_events`
- `operational_objects`
- `operational_relations`
- `operational_operations`
- `object_projections`

Every important context item retains source, range, freshness, hash or Git
revision, selection rationale, and pin/exclusion state.

Markdown is a portable surface, not the canonical memory substrate. Durable HII
memory is object-native: notes, decisions, tasks, receipts, skills, sources,
questions, people, and projects are typed objects connected by versioned
relations and append-only operations.

### Context pipeline

```text
Authorize
→ Discover
→ Filter
→ Fingerprint
→ Extract
→ Normalize
→ Chunk
→ Index
→ Connect
→ Compile
→ Review
→ Deliver
→ Record
```

Project authority is ranked:

```text
scoped AGENTS.md
→ root AGENTS.md
→ accepted architecture and ADRs
→ current code and configuration
→ tests
→ generated summaries
→ historical notes
```

Generated summaries never silently override primary sources.

### Bounded MCP contract

Initial read tools:

```text
hii_list_projects
hii_get_project_state
hii_search_context
hii_build_context_pack
hii_get_context_pack
```

Explicit HII-state write tools:

```text
hii_record_decision
hii_record_task_result
```

Every tool requires an explicit project, enforces approved roots server-side,
returns provenance, creates a receipt, and uses recoverable error envelopes.
Context Dock must not expose unrestricted shell execution or let a model expand
its source permissions.

## Trust constitution

The user must be able to understand what HII knows, where it came from, why it
was selected, who can access it, whether anything left the machine, what is
planned, what occurred, what evidence exists, and how derived state can be
corrected or deleted.

Non-negotiable principles:

- User-owned state.
- Local-first private processing.
- Explicit approved roots and integrations.
- Least context rather than maximal collection.
- Provenance for important information.
- Bounded tools with known side effects.
- Visible external transmission.
- No raw secrets in derived artifacts.
- Reversible local autonomy.
- Explicit approval for publishing, pushing, spending, deletion, secret
  export, or control of non-HII services.
- Receipts over agent claims.
- User correction and deletion of derived state.

Do not use an LLM for deterministic work that ordinary software can perform.
Use rules for inventory and policy, local models for cheap private
classification, larger models only for valuable ambiguity, and cached skills
for repeated verified work.

## Skills and capability compounding

Skills are the after-work memory of successful execution. They are not merely
prompts and must not become an unreviewed command dump.

Every meaningful agent action should be able to report:

- actor and agent runtime;
- project and coordinate;
- intent and bounded action;
- files, commands, tools, or capabilities used;
- outcome and verification status;
- proof artifacts and acceptance evidence;
- side effects, permissions, and risk;
- failures, corrections, and next action;
- whether the workflow appears repeatable.

All reports may enter an append-only local receipt log. Only repeatable,
proof-backed work becomes a skill candidate. A candidate becomes registered
and executable only after schema validation and explicit review. Registration
must record provenance, risk, side effects, required permissions, verification
commands, and source receipts.

Portable skill exports may contain instructions, schemas, safe bundled
resources, verification guidance, and redacted provenance. Export is local by
default. Sharing, publishing, pricing, selling, uploading, or granting licenses
requires a separate explicit action and authority. Commerce remains deferred
from Context Dock 0.1.

## Standard work packet and receipt

Serious work should define objective, why it matters, project and coordinate,
owner, allowed scope, non-goals, relevant context, constraints, acceptance
criteria, validation commands, risk tier, approvals, and expected artifacts.

Every completed task must end with:

```text
Done:
Verified:
Not Verified:
Proof:
Risk:
Next Command:
```

“Done” must not absorb work that was only inspected. Verification must name
what actually ran. Proof may be tests, commands, logs, diffs, files,
screenshots, receipts, or commits.

## Product hierarchy

```text
Level 0 — Founder practice and mission
Level 1 — HII CLI/runtime substrate and verified-work loop
Level 2 — Current launch: one local spatial inference surface
Level 3 — Context Dock, Knowledge Workspace, and daily project intelligence
Level 4 — Authenticated user-owned multi-machine fabric
Level 5 — Foundry and productization systems
Level 6 — Interform, AEC, geometry, media, and business applications
Level 7 — Networks, services, licensing, fabrication, and commerce
Level 8 — Separately permissioned personal operational intelligence
```

The existence of later levels never authorizes claiming transport, observation,
or execution that has not been proven on a live device.

## Deferred and prohibited scope

Do not expand the current release into:

- another chatbot or AI-themed terminal;
- copying proprietary Obsidian code, branding, sync behavior, or plugin APIs;
- blanket email, message, calendar, photo, health, or financial ingestion;
- a full personal ontology or life-data harvester;
- unrestricted autonomous agents or unrestricted shell MCP tools;
- cloud collaboration, mobile, social networking, or broad web crawling;
- a marketplace, payments, credits expansion, runner exchange, or
  third-party decentralized compute system;
- a geometry compiler, CAD replacement, or fabrication marketplace;
- a custom foundation model;
- a dashboard of nonfunctional controls;
- a parallel runtime, daemon, database, or product repository.

Future projects such as Memory Dock, Foundry, Interform, the Form Compiler,
fabrication networks, and personal operational intelligence remain
strategically aligned modules. They must consume the same HII CLI/runtime
context, policy, proof, memory, and capability substrate rather than create
competing systems.

`aii/workstation` is not a forward surface. Archive it or mine it for useful
runtime ideas only. Useful `aii/*` pieces belong behind `hii agent`, `hii caps`,
`hii skills`, `hii proof`, `hii context`, and `hii work`, with receipts as the
completion boundary.

## Current implementation sequence

```text
CD-001  Truthful bootstrap
CD-010  Canonical storage and migrations
CD-020  Source permissions and path policy
CD-030  Inventory and extraction
CD-040  Context compiler
CD-050  Bounded MCP server
CD-060  Complete desktop workflow
CD-070  Trust and provenance
CD-080  Verification and security testing
CD-090  Packaging and founder-beta launch
```

The current priority is a truthful local surface and the smallest real
cross-device proof:

```text
ADR = README = AGENTS.md = CLI help = UI = database = capability metadata
```

Truth fragmentation and simulated remote capability are larger immediate risks
than missing features.

The current product acceptance test is not a larger interface. It is a concrete
external task completed through:

```text
intent -> context -> bounded CLI work -> verification -> receipt -> repeatable report
```

HII development tasks may prove implementation health, but non-HII tasks prove
product value.

## Agent operating directive

Before mutation:

1. Confirm repository, branch, status, and recent history.
2. Read root and scoped `AGENTS.md` and this document.
3. Read current Context Dock architecture and release decisions.
4. Run `hii home --json` first. Use `hii context --json`, `hii caps show`, and
   exact `hii og status` only when the compact home snapshot is insufficient.
5. Inspect schemas, migrations, capability contracts, scripts, routes, and
   relevant tests.
6. Compare implementation truth with this context and report conflicts.
7. Define the smallest coherent patch and its proof target.

During work:

- Preserve unknown user and agent changes.
- Reuse current contracts and add migrations for durable schema changes.
- Keep reads and writes distinct and approval-aware.
- Label mock data and never present it as live truth.
- Do not create a UI control without an implemented capability contract.
- Do not make external calls invisibly.
- Do not push, publish, spend, delete data, export secrets, or widen access
  without explicit authority.
- Record meaningful work, proof, and reusable procedure through HII.

## Definition of done for Context Dock 0.1

A fresh user can install and launch the macOS app, approve a project, see a
reproducible local inventory, build and review a source-linked context pack
within budget, deliver it through bounded MCP, inspect a verified task receipt,
resume after restart, and delete derived project data. Secrets remain excluded,
external transmission remains visible, path boundaries hold, and the packaged
flow survives representative failures.

Required proof includes typecheck, build, targeted unit and integration tests,
MCP boundary checks, path traversal and symlink tests, restart and incremental
scan checks, and a packaged clean-machine smoke test. Anything not exercised is
reported as not verified.

## North stars

**Personal:** Can HII help Ummi move from a thought to a finished, verified
artifact without losing context or agency?

**Context Dock:** Can a user select a project once, build a source-linked pack,
give it to an agent, and receive a verified receipt without re-explaining the
project?

**HII operations:** Can an agent receive bounded work, run through approved
capabilities, remain observable through the CLI/runtime, and return proof that
is easy to review and reuse?

**Platform:** Can one local-first system eventually support code, design,
architecture, fabrication, media, and business through the same context →
execution → proof → memory loop?

**Integrated surface:** Can a user point, select, type, or speak once and have
HII coordinate the right data and capability across their own devices, while
showing what crossed the link, what changed, and what proof came back?

## Final principle

> HII should not give an agent more data. It should give the agent the smallest
> verified context required to act correctly, govern the work through explicit
> capabilities, and give the human proof of what happened.
