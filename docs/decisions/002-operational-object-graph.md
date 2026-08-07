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
