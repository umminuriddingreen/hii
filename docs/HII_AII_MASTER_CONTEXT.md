# HII / AII Master Context

**Founder:** Ummi Nuriddin Green  
**Status:** Founder-level product and architecture context  
**Version:** 1.0  
**Date:** 2026-07-14

This document gives implementation agents one coherent account of what HII and
AII mean, why they exist, what is being shipped now, what belongs later, and
how work must be performed. It prevents product drift, architecture drift,
scope explosion, and truth fragmentation.

## Authority and use

Agents must distinguish four levels of truth:

1. **Founder thesis** explains why HII exists and protects its direction.
2. **System architecture** defines the HII/AII boundary and operating loop.
3. **Current product decision** defines immediate scope: HII Context Dock 0.1.
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

**HII means Human Information Interface.** HII is the local-first, user-owned,
human-facing interface and context system that turns intent into verified agent
work across information, tools, files, machines, memory, and reusable
capabilities.

**AII means Agent Information Interface.** AII is the agent-facing coordination,
policy, and execution layer beneath HII. It publishes capabilities, manages
agent lifecycles, governs actions, coordinates execution, and records proof.

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

## The three scales of HII

### HII as a practice

HII is Ummi's multidisciplinary design and technology practice exploring how
physical, digital, and cognitive environments can expand human capability and
help ideas become reality. Architecture, software, AI, products, construction,
fabrication, education, memory, business systems, and civic institutions are
different materials for designing environments in which intelligence and
coordinated action can emerge.

### HII/AII as platform architecture

At the platform level, HII/AII is the operating architecture for:

```text
context → assignment → execution → observation → verification → memory → repeatability
```

HII makes state understandable and controllable. AII makes agent work bounded,
observable, policy-aware, and repeatable. The shared runtime preserves durable
state and proof while models remain replaceable reasoning engines.

### HII as the product being shipped now

The immediate product is **HII Context Dock 0.1 — Founder Beta**:

> A local-first project context compiler that continuously prepares the
> smallest source-linked context package Codex or ChatGPT needs, then records
> what the agent did and how the result was verified.

The product promise is:

> Select a project once. HII continuously prepares the smallest verified
> context package the agent needs.

The existence of the broader practice and platform does not authorize agents
to widen the current product scope.

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

## HII/AII system boundary

### HII owns the human-facing layer

HII owns the Next.js interface, Tauri desktop shell, projects and sources,
context-pack review, boards, canvas, feed, activity history, terminal surfaces,
approvals, verification views, and receipts.

HII answers:

- What does the system know, and where did it come from?
- What work is active and what is proposed?
- What actually happened?
- What evidence exists?
- What needs approval?
- What happens next?

### AII owns the agent-facing layer

AII owns agent lifecycle, capability publication, policy and approval tiers,
task and run records, managed agent runs, inter-agent messaging, fleet and
process observation, runtime configuration, execution supervision, event
publication, proof collection, and reusable skill promotion.

AII makes execution governable. It must not grant an agent broader authority
than the human supplied.

### Shared runtime

The layers meet through explicit state under `~/.hii`:

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
AII → publishes configuration, capabilities, events, and execution state
    → shared runtime
HII ← reads and presents understandable state
```

HII must not import private AII implementation merely to render state. Typed
contracts, APIs, database records, files, capabilities, and events form the
boundary.

### Models, agents, and tools

```text
Model   = replaceable reasoning engine
Agent   = model + role + task + tools + limits
AII     = policy + coordination + execution management
HII     = human understanding + control + review
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

Context Dock owns the before-work context layer. AII owns the during-work
governance layer. Receipts, memory, and skills close the after-work layer.

## Current product: HII Context Dock 0.1

### User outcome

A user should be able to:

1. Install and launch HII without using a terminal.
2. Add a repository or deliberately selected folder.
3. See exactly what HII may read and what is excluded.
4. Inspect deterministic inventory, formats, Git state, and extraction status.
5. Enter a concrete task.
6. Receive a compact proposed context pack.
7. Inspect why each item was selected and its source provenance.
8. Remove, add, pin, or exclude context before delivery.
9. Make the approved pack available through bounded MCP.
10. Let an agent perform separately authorized work.
11. Record decisions, files changed, verification, blockers, and next action.
12. Resume later without reconstructing project understanding.

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

### Hard architecture decisions

- Use `/Users/ummi/hii`; do not create a parallel product repository.
- Use the existing HII/AII runtime; do not create another daemon.
- Use `~/.hii/hii.db` as the canonical Context Dock store.
- Do not revive obsolete parallel databases.
- Use SQLite FTS5 and deterministic retrieval before embeddings.
- Keep user files in place; store references, metadata, text, hashes, and
  provenance.
- Use MCP as the agent integration contract.
- Require a source path and line/page range for important context.
- Make source transmission explicit and visible.
- Keep source-file mutation outside the Context Dock server.
- Never place raw secrets in context packs, traces, receipts, or logs.

### Context data model

The canonical context entities are:

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

Every important context item retains source, range, freshness, hash or Git
revision, selection rationale, and pin/exclusion state.

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
Level 1 — HII/AII substrate and verified-work loop
Level 2 — Current launch: Context Dock 0.1
Level 3 — Daily project operating intelligence
Level 4 — AII agent operations and multi-machine work
Level 5 — Foundry and productization systems
Level 6 — Interform, AEC, geometry, media, and business applications
Level 7 — Networks, services, licensing, fabrication, and commerce
Level 8 — Separately permissioned personal operational intelligence
```

The existence of later levels never authorizes skipping Level 2.

## Deferred and prohibited scope for Context Dock 0.1

Do not expand the current release into:

- another chatbot or AI-themed terminal;
- an IDE, Obsidian, Notion, or general notes replacement;
- blanket email, message, calendar, photo, health, or financial ingestion;
- a full personal ontology or life-data harvester;
- unrestricted autonomous agents or unrestricted shell MCP tools;
- cloud collaboration, mobile, social networking, or broad web crawling;
- a marketplace, payments, credits expansion, runner exchange, or
  decentralized compute system;
- a geometry compiler, CAD replacement, or fabrication marketplace;
- a custom foundation model;
- a dashboard of nonfunctional controls;
- a parallel runtime, daemon, database, or product repository.

Future projects such as AII Workstation, Memory Dock, Foundry, Interform, the
Form Compiler, fabrication networks, and personal operational intelligence
remain strategically aligned modules. They must consume the same context,
policy, proof, memory, and capability substrate rather than create competing
systems.

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

The first priority is truthful bootstrap:

```text
README = AGENTS.md = CLI help = UI = capability metadata
```

Truth fragmentation is a larger immediate risk than missing features.

## Agent operating directive

Before mutation:

1. Confirm repository, branch, status, and recent history.
2. Read root and scoped `AGENTS.md` and this document.
3. Read current Context Dock architecture and release decisions.
4. Run `hii context --json`, `hii caps show`, and exact `hii og status` when
   available.
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

**AII operations:** Can an agent receive bounded work, run through approved
capabilities, remain observable, and return proof that is easy to review and
reuse?

**Platform:** Can one local-first system eventually support code, design,
architecture, fabrication, media, and business through the same context →
execution → proof → memory loop?

## Final principle

> HII should not give an agent more data. It should give the agent the smallest
> verified context required to act correctly, govern the work through explicit
> capabilities, and give the human proof of what happened.
