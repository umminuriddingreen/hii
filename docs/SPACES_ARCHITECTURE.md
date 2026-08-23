# HII Spaces — Architecture Decisions

**Date:** 2026-08-20
**Basis:** `docs/CURRENT_STATE.md` (evidence-backed audit of commit `54ac1049`).
**Scope:** the smallest set of shared primitives that supports HII Workspace and
HII Spaces without building a parallel platform.

**Implementation status, 2026-08-20:** T1-T3 now implement the first three
primitives described here. LAN mode binds one selected physical network
interface and admits peers from that interface's CIDR; it does not treat an IP
address as proof of physical presence. The visitor listener remains a dedicated
Space-only boundary and does not mount Workspace, terminal, agent, filesystem,
upload, or developer routes.

**Wave 2 status:** blobs remain local under the existing per-Space asset root,
with magic/structure validation, metadata stripping, quotas, opaque references,
and no anonymous delete route. `/s/:id` now projects a reduced capability set
through the existing `HiiRoot`; browser state is isolated per Space behind the
persistence seam that T6 will replace.

**Waves 3-5 status:** the operational graph is canonical for Space mutations
and projects through the locked workspace document; Workspace remains
JSON-canonical. Guest authority, policy, realtime, presence, and moderation are
enforced by the host. Operator routes live on a separate loopback listener.
Publication uses a third loopback listener with explicit `public` audience,
scoped to one published Space per node; it never mounts operator or Workspace
authority. Guest identity, invitations, and revocations are process-local.

---

## 0. The one decision everything else follows from

> **A Space is a workspace with an identity record, a policy, and a host.**

The repository already stores canvas state per workspace id at
`~/.hii/workspace/workspaces/<id>.json`, and already partitions the
operational graph by `space_id`. HII does not need a new object system,
a new database, or a new canvas. It needs:

1. a **Space record** that gives that id an owner, a policy, and a hosting state;
2. a **server that binds to the LAN**, which does not exist today;
3. an **incremental object-event channel**, whose write path
   (`applyGraphMutation`) already exists and is unused by the UI.

Everything else in this document is downstream of those three.

---

## 1. Existing components we should reuse

### 1.1 Canvas UI

```text
component:       HiiRoot / NodeFrame / useCamera / useWorkspace
path:            components/workspace/
reason:          Verified working pan, zoom, drag, resize, multi-select,
                 marquee/lasso, delete, undo/redo, 26 node types. It renders
                 in any browser — `hii-bridge` already branches on Tauri.
required changes:
  - Extract the interaction core so Spaces can mount a reduced surface.
    Do NOT fork the file. Introduce a `surface` prop / capability set:
    Workspace enables all node types and the command bar; Spaces enables
    image/text/sticker/drawing and nothing else.
  - Add pinch-zoom and two-finger pan to useCamera.ts (§Canvas gaps below).
  - Add a touch resize handle and an on-screen delete affordance to NodeFrame.
  - Route mutations through a transport interface rather than calling
    workspace.addNode/patchNode/removeNode directly, so the same component
    can drive localStorage, Tauri IPC, or a websocket.
```

### 1.2 Canvas object model

```text
component:       WorkspaceNode / WorkspaceDoc
path:            lib/workspace/types.ts
reason:          Already carries id, type, x, y, w, h, z, createdAt, updatedAt,
                 payload, and optional governed metadata. The four Spaces object
                 types map onto existing types with no new model:
                   Image    -> 'image'
                   Text     -> 'canvas-text'
                   Drawing  -> 'ink'      (model exists; renderer missing)
                   Sticker  -> 'image' with payload.sticker = true
required changes (all additive, all optional-typed so existing documents load):
  - rotation?: number         — absent today; §8 of the brief requires it
  - spaceId?: string          — so an object is self-describing on the wire
  - creatorId?: string        — 'user:<id>' or 'guest:<id>'
  - permissions?              — omit for MVP; policy is evaluated at the Space
                                level, not per object (see §6)
Do not add a parallel `SpaceObject` type. One model, two surfaces.
```

### 1.3 Durable canvas persistence

```text
component:       workspace file store
path:            crates/hii-core/src/lib.rs (Rust, shipping)
                 lib/server/workspace-store.ts (TypeScript, safer, unreachable from the app)
reason:          The on-disk layout ~/.hii/workspace/workspaces/<id>.json +
                 selection.json is ALREADY per-space. Atomic write, revision
                 counter, and (on the TS side) file locking, revision-conflict
                 detection, id validation, and corruption preservation.
required changes:
  - Pick ONE implementation as authoritative for the Spaces host. Recommend
    the Node one: it has the locking and conflict semantics a multi-writer
    host needs, and the Spaces host is a Node process (§4.1).
  - Rust keeps read/write for the single-user desktop path unchanged.
  - Reuse validateWorkspaceId() verbatim as the Space-id validator —
    it is already URL-safe (^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$).
```

### 1.4 Blob storage

```text
component:       workspace_asset_store
path:            src-tauri/src/lib.rs:89-106
reason:          Working content-addressed-ish asset write to
                 ~/.hii/workspace/assets/ with size cap and filename sanitization.
required changes:
  - Generalize into an HTTP endpoint on the Spaces host so a phone can upload.
  - Add the upload-safety controls that do not exist today (§15 of the brief):
    MIME allowlist, image-dimension cap, EXIF strip, per-space quota,
    Content-Disposition, rate limit. The Tauri path can then call the same
    validator.
  - Namespace by space: ~/.hii/workspace/assets/<space_id>/.
```

### 1.5 Object mutation log

```text
component:       operational graph — applyGraphMutation / readOperationHistory
path:            lib/server/operational-graph-mutations.ts
                 lib/server/operational-object-store.ts
reason:          This is already an object/event system, not a state blob.
                 operational_operations has space_id, actor_id, device_id,
                 lamport (UNIQUE per space), idempotency_key (UNIQUE partial),
                 operation_hash, authority_grant_id. Optimistic concurrency by
                 stated version. Three separate version domains so a MOVE does
                 not invalidate semantic review. Tests pass.
required changes:
  - Add object.create / object.move / object.update / object.delete as
    mutation types, if not already expressible — these map onto the existing
    semantic-vs-projection version split exactly (move = projection version,
    update = semantic version).
  - Flip canonical_source from 'workspace-json' to 'graph' FOR SPACES ONLY.
    Workspace keeps JSON-canonical until ADR 002's migration completes.
  - Lamport ordering already gives the total order a broadcast channel needs.
```

### 1.6 Authority / permission ledger

```text
component:       object grants + governed objects
path:            lib/server/object-grants.ts, lib/server/governed-objects.ts
reason:          Append-only JSONL ledger of (subject × space × objects ×
                 operations × expiry) with active/superseded/revoked/expired
                 lifecycle and grantToScope() evaluation. readOnlyScope(spaceId, …)
                 already exists. This is the right shape for Space policy.
required changes:
  - Add a subject kind for guests. Today a grant subject is an agent/run.
  - Add space-level (not only object-level) scope, so "LOCAL WRITE" is one
    grant rather than N.
  - Keep it advisory-free: the host must ENFORCE the scope on the write path,
    not merely record it.
```

### 1.7 Public exposure without new networking

```text
component:       Tailscale Funnel control + hardened gateway
path:            server/remote-test-core.mjs:185-300, server/remote-test-gateway.mjs
reason:          Proven, working: funnelStartArgs/funnelStopArgs, preflight for
                 BackendState==Running and port-not-already-claimed, route
                 ownership check, per-connection sliding-window rate limiter,
                 message size cap, disconnect grace, generated session secrets,
                 extension allowlist for served artifacts.
                 §12 of the brief explicitly permits proven external tunneling.
required changes:
  - Extract the funnel lifecycle + limiter + secret handling into a reusable
    module. Do not import the remote-terminal gateway itself — its purpose
    (shell access) must never be adjacent to a public visitor surface.
  - The tunnel provides HOSTING. It must never provide IDENTITY (§5).
```

### 1.8 Save-conflict merge

```text
component:       rebaseWorkspaceDoc
path:            lib/workspace/rebase.ts
reason:          Correct delete-aware three-way merge with tests, currently
                 called by nothing. Multi-writer Spaces makes it necessary.
required changes:
  - Call it. On a revision conflict the host rebases rather than rejecting.
  - It is the fallback for whole-document sync; the event channel is the
    primary path.
```

### 1.9 Space id validation and URL safety

```text
component:       validateWorkspaceId
path:            lib/server/workspace-store.ts:73-81
reason:          Already produces path-safe and URL-safe ids and rejects
                 traversal. Reuse unchanged for /s/:space_id.
required changes: none.
```

---

## 2. Existing components that should remain Workspace-only

| Component | Path | Why it must not reach Spaces |
|---|---|---|
| Agent runs | `src-tauri` `agent_start`, `cli/src/agent.rs` | A public visitor must never be able to start a process on the host. |
| Terminal node + PTY gateway | `HiiRoot` TerminalBody, `server/pty-*.mjs` | Shell access adjacent to an anonymous surface is the single worst outcome available. |
| Browser node / governed web | `NativeDevBrowser`, `crates/hii-core/src/web/` | Host-side network egress driven by a visitor. |
| Remote-test gateway | `server/remote-test-gateway.mjs` | Purpose-built for authenticated remote shell. Reuse its *patterns*, never its server. |
| Marketplace, notifications, HII Link, music, apps dock | `components/workspace/Hii*.tsx` | Operator surfaces. Not part of the visitor loop. |
| Knowledge / memory / receipts / capabilities | `lib/server/hii-*.ts`, `cli/src/*` | Workspace's reason to exist; irrelevant to §10's demo. |
| Presence (operator continuity) | `cli/src/presence.rs` | Different concept, same word. See §7. |
| AeroSpace control | `scripts/hii-space.mjs` | Different concept, same word. See §7. |

---

## 3. Existing components that should be generalized

| Component | Today | Generalization |
|---|---|---|
| `WorkspaceNode` | canvas node | + `rotation`, `spaceId`, `creatorId` (all optional) |
| `workspace-store.ts` | named workspace files | the Space *state* store, given a Space *record* store beside it |
| `workspace_asset_store` | Tauri IPC, owner-trusted | HTTP blob endpoint with untrusted-input validation |
| object grants | agent authority | + guest subjects, + space-level scope |
| `applyGraphMutation` | Node library | the write path behind the host's event channel |
| funnel control | remote-test only | reusable publication module |
| `HiiRoot` | one full surface | capability-gated surface (`workspace` \| `space`) |
| `useCamera` | mouse/trackpad | + pinch-zoom, + two-finger pan |

---

## 4. New components that are genuinely required

### 4.1 The Spaces host process

```text
new:    a Node HTTP + WebSocket server that binds to 0.0.0.0
why:    Nothing in the tree binds to anything but 127.0.0.1 (verified by
        exhaustive grep — zero occurrences of '0.0.0.0'). Without this, no
        phone on the same Wi-Fi can reach anything. This is the hard blocker
        for the entire §10 demo.
owns:   HTTP: GET /s/:id (app shell), GET /api/spaces/:id (snapshot),
        POST /api/spaces/:id/objects, POST /api/spaces/:id/blobs
        WS:   /api/spaces/:id/events — join, object.*, presence.*
not:    it does not own state. It reads/writes through workspace-store.ts and
        applyGraphMutation. It is a transport and a policy enforcement point.
runtime: Node, because workspace-store.ts, the graph store, the grants ledger,
        and the funnel control are all already Node. Reimplementing them in
        Rust to satisfy ADR 004 would be the largest avoidable cost in this
        project. Register it as a CLI-owned subcommand (`hii spaces serve`)
        so ADR 004's ownership rule is honored at the contract level even
        while the implementation is Node.
```

### 4.2 The Space record store

```text
new:    ~/.hii/spaces/<space_id>.json  (+ index)
why:    A Space needs identity, owner, name, policy, hosting mode, publication
        state, and created/updated stamps. None of that exists — the workspace
        file has no owner and no policy, and the graph has a space_id column
        but no space table.
why not SQLite: the authoritative canvas state is already a JSON file per
        space with atomic write + locking. Splitting a Space's identity into a
        different storage engine than its contents creates exactly the
        ambiguous dual ownership §22 forbids. One space = one directory.
shape:  see §6.
```

### 4.3 Guest identity

```text
new:    guest_<random> issuance + signed session cookie/token
why:    §D of the audit: no guest concept exists. HII identity today is a
        signed operator contact card — a single-owner primitive.
scope:  ephemeral, per-space, no account, no PII. The token proves only
        "this browser is the one that created object X".
```

### 4.4 Presence channel

```text
new:    ephemeral in-memory participant list per space
why:    Nothing named "presence" in this repo means multi-user presence.
never persisted: presence is connection state. It dies with the socket.
```

### 4.5 QR / access-link generation

```text
new:    a QR encoder + a canonical access URL builder
why:    Absent entirely (no dependency, no generator, no route).
        §19 makes the QR the distribution mechanism, so it cannot be
        an afterthought behind a settings screen.
```

### 4.6 Upload validation

```text
new:    MIME allowlist, magic-byte sniff, dimension cap, EXIF strip,
        per-space quota, safe generated filename, Content-Disposition,
        per-guest rate limit
why:    The current asset path enforces a 250 MB cap and a filename
        sanitizer, and nothing else. It has only ever accepted input from
        the machine's owner.
```

### 4.7 Space resolution at the public domain

```text
new:    humaninformationinterface.com/s/:id -> currently published endpoint
why:    §8 of the brief: the ID must outlive the host. This is a small
        mapping service, NOT a relay and NOT a replica.
```

---

## 5. Components that should NOT be built yet

Frozen per §20 of the brief, plus items this audit shows are premature:

```text
custom NAT traversal / relay / VPN / WireGuard replacement
remote read replicas or caches (P11)
CRDT convergence (last-writer-wins by lamport is sufficient for MVP)
accounts, billing, analytics dashboards
a second canvas implementation for mobile
migrating the operational graph to canonical for Workspace (ADR 002 continues
  on its own schedule; Spaces opts in independently)
rewriting the Spaces host in Rust
per-object ACLs (space-level policy is enough for the MVP matrix)
deleting anything under archive/
```

Additionally deferred, with a reason specific to this repo:

```text
Rebuilding the marketing site. The live site's source is archived (§E.1 of the
audit). That must be resolved as a deliberate decision, not as a side effect of
adding /spaces. See "Open decision" below.
```

---

## 6. Canonical state ownership

There is exactly one owner per fact. No duplicates.

| Fact | Owner | Location | Notes |
|---|---|---|---|
| **Space metadata** (id, name, owner, created) | Space record | `~/.hii/spaces/<id>.json` | New. Authoritative. |
| **Permissions / policy** | Space record | same file, `policy` field | Evaluated by the host on every write. The grants ledger records *derived* guest grants; the policy is the source. |
| **Hosting mode** (local-only / published) | Space record | same file, `hosting` field | Reflects intent. |
| **Publication state** (current public endpoint) | Space record, `publication` field | same file | The *endpoint* is provider state; the *record of it* is the Space's. |
| **Canvas objects** | Workspace document | `~/.hii/workspace/workspaces/<id>.json` | Unchanged location. The Space id **is** the workspace id. |
| **Object mutation history** | Operational graph | `~/.hii/hii.db` | `canonical_source='graph'` for spaces. Ordering by `lamport`. |
| **Blobs** | Filesystem | `~/.hii/workspace/assets/<space_id>/` | The document holds a reference, never bytes. |
| **Participants (live)** | Host process memory | not persisted | Dies with the process, by design. |
| **Participants (historical)** | Operational graph | `operational_operations.actor_id` | A guest's contributions outlive their session. |
| **Guest identity** | Host process + signed token | token is the only durable artifact | No guest record is written. |
| **Realtime state** (cursors, sockets) | Host process memory | not persisted | Never. |

**The rule that prevents ambiguity:** a Space's *identity and policy* live in
`~/.hii/spaces/<id>.json`. A Space's *contents* live in
`~/.hii/workspace/workspaces/<id>.json` and `assets/<id>/`. They share the id.
Neither file duplicates a field of the other.

**Why the Space id equals the workspace id:** it makes the existing durable
store the Spaces store with no migration, no adapter, and no second source of
truth — and it means a Workspace can become a Space by gaining a record, which
is the cheapest possible path to §17's "shared primitives, different surfaces".

---

## 7. Naming

Three concepts currently share two words. Before writing code:

| New name | Meaning | Renamed from |
|---|---|---|
| **Space** | the product primitive defined here | (new) |
| **display space** | AeroSpace/macOS window-manager workspace | "space" in `scripts/hii-space.mjs` |
| **operator presence** | continuity/attention/authority projection | "presence" in `cli/src/presence.rs` |
| **participant presence** | who is in a Space right now | (new) |

`space_id` in the operational graph already means "the workspace/Space
partition key" and needs no change — it becomes accurate rather than aspirational.

Renames of existing symbols are documentation-first; do not churn
`cli/src/presence.rs` or `scripts/hii-space.mjs` while building Spaces.

---

## 8. Open decision requiring the owner

**Which application does `humaninformationinterface.com` serve?**

The deployed site is a SvelteKit build whose source is in `archive/`; the
buildable site is the Next.js static export, which cannot host `/s/:space_id`
(no server, no dynamic routes under `output: 'export'`). Three options:

1. **Add a small Cloudflare Worker** for `/spaces`, `/new`, `/s/:id` alongside
   the existing deployment. Lowest risk, does not touch the live homepage,
   and `/s/:id` needs a server anyway. **Recommended.**
2. Restore the SvelteKit source from `archive/` and add routes there.
3. Port the live site to Next.js and change the deployment.

This decision blocks P8 (stable public route) only. P0–P7 are entirely local
and can proceed without it.
### T13 deployment boundary

The owner selected the separate path-scoped Worker option. Preview and
production entrypoints are distinct. Preview may use immutable derived fixture
data; the production entry is fail-closed and does not import that fixture.
The planned zone Routes are `/spaces`, `/spaces/*`, `/new`, `/new/`, and
`/s/*`. Every other URL remains owned by the existing `hii` Custom Domain
Worker. Cloudflare is a resolver/read-projection surface, never the canonical
Space store. See `docs/SPACES_PRODUCTION_TOPOLOGY.md`.
