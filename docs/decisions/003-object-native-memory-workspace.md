# ADR 003: HII memory is object-native, not Markdown-native

Status: accepted, first slice in progress

## Decision

HII's durable memory layer is the local workspace object graph in
`~/.hii/hii.db`, not a folder of Markdown files.

Markdown remains important as a portable import/export and human editing format,
but it is not the canonical form of HII memory. Canonical memory is a set of
typed, versioned, source-aware objects connected by typed relations and recorded
through append-only operations.

This is the product boundary for "Obsidian and Notion, bounded within HII":

- a local workspace of objects, not a remote database;
- object identity survives view changes, exports, and agent handoffs;
- agents operate on reviewed object scopes, not the whole vault;
- every write carries actor, intent, run, idempotency, version, and provenance;
- concurrent agents are handled through replay keys and optimistic concurrency;
- receipts and skills are first-class memory objects, not afterthought files;
- Markdown export exists so HII never becomes data lock-in.

## Canonical memory atoms

The initial HII memory object kinds are:

- `memory.note`
- `memory.decision`
- `memory.task`
- `memory.receipt`
- `memory.skill`
- `memory.source`
- `memory.question`
- `memory.person`
- `memory.project`

Each memory stores structured blocks, tags, status, source refs, and open-ended
facets. Blocks can represent text, checks, code, or embedded object references.
This gives HII the expressive feel of a note workspace while preserving
machine-readable semantics for agents.

## Concurrency model

Concurrent work is normal. HII therefore treats memory writes as operations:

- create operations may carry an idempotency key and replay safely;
- patches must state the semantic version they were decided against;
- stale patches are refused instead of overwriting unseen work;
- relations are graph records with their own provenance and operation history;
- tombstones preserve history rather than deleting evidence.

This is stricter than Markdown merge behavior because agents need explicit proof
of what they saw, what they changed, and whether someone else changed it first.

## Skills as memory

Skills are object-native memory too. A skill starts as a `memory.skill` object
linked to source receipts, tasks, decisions, and proof. Only reviewed,
proof-backed skills should become executable capability registrations. The
registration file is a distribution artifact; the object graph is the durable
memory of why the skill exists.

## Relationship to existing ADRs

ADR 001 reopened an Obsidian-class HII Knowledge Workspace. ADR 002 made
operational objects the shared substrate. This ADR resolves the apparent
tension: HII should provide Obsidian/Notion-class knowledge work, but by making
objects primary and treating Markdown as an edge format.

## Consequences

- HII can offer notes, tables, boards, graph views, canvases, timelines, and
  agent runs as projections over the same state.
- Agents can memorize by writing bounded objects and relations, not by appending
  opaque summaries.
- Human corrections become new operations over durable objects.
- Local export remains possible without surrendering the object model.
- Future personal operating intelligence must be separately permissioned and
  scoped to selected workspaces instead of becoming blanket life-data ingestion.
