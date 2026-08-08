# ADR 002: Operational objects are HII's shared substrate

Status: accepted, incremental migration in progress

## Decision

HII's primary product model is a persistent information environment in which
humans and intelligences operate on the same objects. Views and agent runtimes
are consumers of that environment; they are not its owners.

Every durable item will converge on a versioned `OperationalObject` in
`~/.hii/hii.db`. Typed `Relation` records connect objects. `Operation` records
describe mutations by humans, agents, and HII. Projection records hold
view-specific state such as spatial position without making the view the
semantic source of truth.

The initial implementation projects Workspace JSON into four additive tables:

- `operational_objects`
- `operational_relations`
- `operational_operations`
- `object_projections`

Workspace node IDs and link IDs are preserved inside stable namespaced IDs and
provenance. Removed legacy records become tombstones. Replaying a Workspace
revision is idempotent.

## Versioned mutations (2026-08-08)

The graph is now writable directly, not only by projecting Workspace JSON. It
remains one graph: the same four tables, extended additively.

**Three version domains, deliberately separate.** Semantic version covers
properties, type, ownership and semantic tombstone state. Projection version
covers position, size, z-order, frame placement and visibility. Relation version
covers relation metadata, provenance state and relation tombstone state. A move
must not invalidate the semantic context an approved run was reviewed against,
and a semantic edit must not look like the object was dragged. One number could
not express either.

**Optimistic concurrency.** Every patch and tombstone states the version it was
decided against. A caller holding a stale version is refused rather than having
its decision applied to state it never saw.

**Idempotency.** A mutation may carry a replay key. The key is stored with a
deterministic hash of the operation's content, so a retry returns the original
result and a *different* write reusing a key is refused rather than silently
dropped.

**Canonical ownership.** Objects, relations and projections carry
`canonical_source`. Records projected from Workspace JSON are `workspace-json`
and cannot be mutated graph-first — the next autosave would overwrite the change
without anyone noticing, so the write is refused with that reason. Records
created through the mutation API are `graph` and are not tombstoned for being
absent from the JSON.

**Authored links are not provenance.** Every workspace link projects as
`AUTHORED_LINK` with its label preserved as a property. Previously the label
became the relation type, which meant typing `VERIFIED_BY` on an arrow forged
proof. `VERIFIED_BY` now requires a satisfied completion assessment with declared
proof, checked through the same policy every other high-trust surface uses.

**Atomicity, and its boundary.** Validation, operation recording, mutation and
resulting-version recording happen in one SQLite transaction: an operation record
exists only if it applied. HII does *not* claim atomicity across Workspace JSON
and SQLite — they are two files with no shared transaction. Workspace save stays
canonical; the graph follows idempotently and is reconciled by replaying a
revision.

Refusals are structured codes, not strings: `missing-target`, `stale-version`,
`tombstoned-target`, `idempotency-conflict`, `invalid-operation`,
`invalid-relation`, `dangling-relation`, `canonical-owner-mismatch`,
`authority-mismatch`.

Tombstones hide records; they never remove rows or the operations that produced
them.

## Migration boundary

Workspace JSON remains the authority and rollback/export source during this
phase. Every normal save dual-writes the graph. Existing workspaces can be
backfilled explicitly through the local-only Workspace API. The graph is
readable through that same boundary for projection development and migration
reconciliation.

HII will not switch graph authority on until migrations reconcile counts and
identity, multi-projection editing is proven, and rollback/export behavior is
tested against real user data.

## Consequences

- Canvas, documents, tables, graphs, timelines, conversations, and agents can
  converge on stable identity instead of copying context between subsystems.
- Spatial layout remains a projection, while meaning, provenance, and typed
  relationships remain durable and queryable.
- Agent changes can become reviewable operations over shared objects.
- Runtime, cloud, channel, scheduling, and collaboration work must preserve the
  object and operation contracts rather than create separate brains.

This ADR supersedes any product framing that treats agent execution or a single
application-shaped surface as HII's center of gravity.
