# HII Spaces — Implementation Plan

**Date:** 2026-08-20
**Basis:** `docs/CURRENT_STATE.md`, `docs/SPACES_ARCHITECTURE.md`, `docs/SPACES_GAP_ANALYSIS.md`

## Execution status

- T1 canonical Space record: complete and process-restart proven.
- T2 explicit LAN host: implementation and automated security gate complete;
  real-interface same-machine smoke passed; physical second-device proof open.
- T3 canonical object model: complete as additive `WorkspaceNode` fields and
  existing-type mappings; no parallel `SpaceObject` was introduced.
- Next dependency-safe wave: T4 blob/upload and T5 mobile/touch canvas, with the
  upload contract fixed by the lead before parallel implementation.
- T4 blob/upload: complete with adversarial upload review and restart proof.
- T5 mobile/touch surface: complete in code and focused tests; physical phone
  behavior remains unverified.
- Next wave: T6 realtime object events and T7 persistence/concurrency proof.
- T6 realtime: complete with adversarial replay, ordering, snapshot-size, and resource-bound remediation.
- T7 persistence: complete for process/SIGKILL restart and cross-language locking; sudden power-loss remains unproven.
- Next wave: T8 guest identity, T9 policy, T10 host controls, and T12 QR/share entry.
- T8-T10 and T12: complete locally, including loopback operator UI/API and
  adversarial authority review; physical QR/device proof remains open.
- T11 publication: complete with mocked Funnel provider tests and public/local
  audience isolation; no external publication was invoked.
- T13 production route: blocked on the owner choice and Cloudflare route
  ownership verification. Recommended path remains a separate path-scoped
  Worker that leaves the live SvelteKit homepage untouched.

Ordered by **dependency × impact × uncertainty**, not by calendar phase.
Uncertainty is called out because it should drive *sequence*: the two highest-
uncertainty items (T2 LAN binding, T9 policy-by-origin) are pulled as early as
their dependencies allow, so a wrong assumption is discovered cheaply.

Global non-goals for every task: no cryptocurrency, no marketplace, no 3D, no
custom VPN/NAT/relay, no blockchain identity, no CRDT, no distributed consensus,
no deletions from `archive/`, no rewrite of `HiiRoot.tsx`, no ADR 002 migration
of Workspace to graph-canonical.

Global verification for every task: `npm run check` · `npx vitest run` ·
`cargo check --workspace` when Rust changes · plus the task's own criteria.
UI tasks require behavioral verification, not compilation. Networking tasks
require two distinct clients. Persistence tasks require an actual process restart.

---

## Tier 0 — Unblocks everything

### T1 · Canonical Space record

```text
Objective
  A Space has a permanent id, an owner, metadata, a policy, a hosting mode, and
  a publication state, stored at ~/.hii/spaces/<space_id>.json with an index.

Why it is needed
  Every later task references a Space. Today an id is only a filename with no
  owner, no policy, and no hosting concept (audit §D). This is P0 in the brief
  and the gap analysis agrees from evidence.

Existing code to reuse
  lib/server/workspace-store.ts  — validateWorkspaceId() verbatim (already
                                   URL-safe and traversal-proof); the
                                   atomicWriteFile + withFileLock pattern;
                                   the WorkspaceNotFoundError shape
  lib/server/atomic-write.ts     — atomicWriteFile, withFileLock
  lib/server/object-grants.ts    — the policy/lifecycle vocabulary to mirror

Files/packages likely affected
  lib/spaces/types.ts            (new)  Space, SpacePolicy, HostingMode,
                                        PublicationState, Participant
  lib/server/space-store.ts      (new)  create/read/update/list/delete + index
  tests/unit/space-store.test.ts (new)
  scripts/hii-spaces-smoke.mjs   (new)
  package.json                          + "hii:spaces:check", added to ci:product

Dependencies
  none

Acceptance criteria
  - createSpace({name, owner}) returns a validated id and writes the record
  - The record round-trips through a process restart unchanged
  - An invalid id is rejected before any filesystem access
  - The Space id is usable unmodified as a URL path segment
  - readSpace() on an unknown id raises SpaceNotFoundError, never throws ENOENT
  - Concurrent writes are serialized by the file lock
  - The record contains NO canvas objects and NO blobs (ownership rule, arch §6)

Tests
  unit: id validation incl. traversal attempts; create/read/update/list;
        default policy is local-only/local-write; unknown id; concurrent write;
        corrupt file preserved rather than lost (mirror preserveUnreadable)
  smoke: create -> restart node -> read -> identical

Risks
  Low. Pure local file I/O against a proven pattern.
  Watch: do not duplicate any field that belongs to the workspace document.

Explicit non-goals
  No SQLite table. No UI. No server. No policy enforcement yet — the record
  only *states* policy; T5 enforces it.
```

### T2 · Spaces host bound to a LAN interface  ← highest uncertainty

```text
Objective
  A Node process that serves a Space over HTTP on a LAN interface, so a phone
  on the same Wi-Fi can open it. HTTP only in this task; no realtime yet.

Why it is needed
  Verified hard blocker: every listen() in the repository binds 127.0.0.1 and
  '0.0.0.0' appears nowhere in the tree. Without this, steps 5-14 of the §10
  demo are unreachable. Highest uncertainty in the project (interface choice,
  macOS local-network permission, captive-portal and client-isolation Wi-Fi),
  so it is sequenced immediately after T1 rather than after the canvas work.

Existing code to reuse
  lib/server/workspace-store.ts       — read/write the Space's canvas document
  lib/server/space-store.ts           — T1
  server/remote-test-core.mjs         — the preflight-check pattern
  server/remote-test-gateway.mjs      — SlidingWindowLimiter, json() helper,
                                        nosniff/no-store header discipline
                                        (patterns only — do NOT import that server)

Files/packages likely affected
  lib/spaces/host/server.ts      (new)  createSpacesHost({ host, port })
  lib/spaces/host/routes.ts      (new)  GET /s/:id, GET /api/spaces/:id
  cli/src/spaces.rs              (new)  `hii spaces serve` (ADR 004 ownership)
  cli/src/main.rs                       register the subcommand
  tests/unit/spaces-host.test.ts (new)

Dependencies
  T1

Acceptance criteria
  - Binds an explicitly chosen interface; default stays 127.0.0.1 and LAN
    exposure requires an explicit flag/confirmation
  - `curl http://<lan-ip>:<port>/api/spaces/<id>` from a second device returns
    the Space snapshot
  - A phone on the same Wi-Fi loads GET /s/<id>
  - Unknown space id -> 404 with no filesystem detail in the body
  - Path traversal via :id is impossible (validator runs first)
  - The host prints the exact URL and which interface it chose
  - Serves ONLY space routes. No terminal, no agent, no filesystem browse.

Tests
  unit: route table, 404s, traversal rejection, snapshot shape,
        interface-selection logic with an injected interface list
  manual: second physical device on the same LAN loads the URL

Risks
  HIGH.
  - macOS local-network permission prompt on first bind (Sonoma+). Must be
    handled with a clear message, not a silent failure.
  - Wi-Fi client isolation (common on guest networks) silently breaks LAN
    reachability. Detect and say so rather than appearing hung.
  - Binding 0.0.0.0 exposes the process to the whole network. Mitigation:
    space routes only, explicit opt-in, printed warning, and no host-privileged
    endpoint on this server ever.

Explicit non-goals
  No WebSocket. No uploads. No tunnel. No auth. No 0.0.0.0 by default.
```

---

## Tier 1 — The visitor can do something

### T3 · Object model extension

```text
Objective
  WorkspaceNode gains optional rotation, spaceId, creatorId. Sticker becomes
  expressible. No breaking change to any existing document.

Why it is needed
  §8 of the brief requires rotation and a creator; the wire format needs
  spaceId to be self-describing. All three are absent (audit §4 answer 2).

Existing code to reuse
  lib/workspace/types.ts — WorkspaceNode, normalizeWorkspace (which must
  supply defaults so pre-existing documents load unchanged)

Files/packages likely affected
  lib/workspace/types.ts, lib/workspace/ingest.ts,
  components/workspace/NodeFrame.tsx (apply rotation in the transform),
  tests/unit/workspace-types.test.ts

Dependencies
  none (can run parallel to T2)

Acceptance criteria
  - An existing ~/.hii workspace document loads with zero changes
  - rotation defaults to 0 and is applied in NodeFrame's CSS transform
  - `cargo check` still passes — crates/hii-core validates version/nodes/viewport
    only, so additive fields must not trip write_workspace()
  - Round-trip through Rust write_workspace preserves the new fields

Tests
  unit: normalize defaults; round-trip; rotation renders in the transform
  integration: write a node with the new fields through hii-core, read back

Risks
  Low. Guard: hii-core's write_workspace is a shallow validator; confirm it
  does not strip unknown keys (it serializes the Value as received).

Explicit non-goals
  No per-object permissions (policy is space-level for MVP). No rotate gesture.
```

### T4 · Blob endpoint with upload safety

```text
Objective
  A phone can upload a photo and it survives a restart. Blobs live at
  ~/.hii/workspace/assets/<space_id>/ and are served safely.

Why it is needed
  Verified defect: ingest.ts POSTs to /api/workspace/assets, a route that does
  not exist and cannot exist under output:'export'. Every image on the web
  canvas is an ephemeral blob: URL today. This is also the first point where
  HII accepts untrusted bytes, so the §15 controls land here, not later.

Existing code to reuse
  src-tauri/src/lib.rs:89-106  — workspace_asset_store: size cap, sanitized
                                 name, run-id prefix. Port the shape.
  safe_asset_name()            — the sanitizer to mirror
  SlidingWindowLimiter         — from remote-test-gateway.mjs
  lib/workspace/ingest.ts      — already calls the endpoint this task creates,
                                 so the client change is nearly nil

Files/packages likely affected
  lib/spaces/host/blobs.ts        (new)  POST /api/spaces/:id/blobs, GET blob
  lib/spaces/upload-policy.ts     (new)  allowlist, sniff, dimensions, EXIF,
                                         quota, safe name
  lib/workspace/ingest.ts                point at the space-scoped endpoint
  tests/unit/spaces-upload-policy.test.ts (new)

Dependencies
  T1, T2

Acceptance criteria
  - MIME allowlist enforced by magic bytes, not by the declared header
  - Size limit is per-space configurable with a low default (not 250 MB)
  - Image dimension cap rejects decode bombs before decoding fully
  - EXIF (incl. GPS) stripped from uploaded images
  - Stored filename is generated, never derived from user input
  - Served with Content-Disposition: attachment and X-Content-Type-Options: nosniff
  - Uploaded HTML/SVG can never execute as application content
  - Per-guest rate limit; per-space storage quota enforced
  - Upload -> restart host -> image still renders

Tests
  unit: each control independently, including a file whose declared MIME lies;
        an SVG with a script; an image with GPS EXIF; quota exhaustion
  integration: upload from a second device, restart the host, reload

Risks
  Medium. This is the primary attack surface of the entire product.
  Do not ship a public pilot with any control unimplemented.

Explicit non-goals
  No transcoding, no thumbnails, no CDN, no virus scanning, no content
  classification. Moderation hook is T10.
```

### T5 · Spaces canvas surface (touch)

```text
Objective
  On an iPhone/Android browser: open a Space, pan, pinch-zoom, add an image
  from the camera, add text, add a sticker, move, resize, and delete one's own
  object. (P1 in the brief.)

Why it is needed
  The canvas exists and is desktop-shaped: no pinch handler, resize is Alt+drag,
  delete is a keyboard key, there is no file/camera input, and the drawing model
  has no renderer (audit matrix).

Existing code to reuse
  components/workspace/HiiRoot.tsx      — capability-gate it; do not fork
  components/workspace/useCamera.ts     — extend
  components/workspace/NodeFrame.tsx    — extend
  components/workspace/useWorkspace.ts  — swap its persistence for a transport
  lib/workspace/gestures.ts             — the batched, always-tearing-down
                                          pointer gesture core, already correct
                                          for this and currently underused
  lib/workspace/ink.ts                  — complete stroke model + simplification,
                                          needs only a renderer and a capture path
  lib/workspace/selection.ts, ingest.ts — as-is

Files/packages likely affected
  components/workspace/useCamera.ts, NodeFrame.tsx, HiiRoot.tsx
  components/spaces/SpaceCanvas.tsx    (new, thin — composes the above)
  components/spaces/SpaceToolbar.tsx   (new)
  components/workspace/InkBody.tsx     (new — the missing 'ink' renderer)
  tests/unit/use-camera-pinch.test.ts, spaces-surface.test.tsx (new)

Dependencies
  T3 (rotation/creator), T4 (durable images)

Acceptance criteria
  On a real phone browser:
  - one-finger drag pans; two-finger pinch zooms about the pinch midpoint
  - camera button captures a photo and it appears as an object
  - text and sticker objects can be created with touch alone
  - an object can be moved and resized by touch (visible handle)
  - a delete control is reachable without a keyboard
  - a freehand drawing can be made and it renders after reload
  - the Spaces surface shows NO terminal, browser, marketplace, agent prompt,
    or apps dock
  - Workspace's own behavior is unchanged (regression check)

Tests
  unit: pinch math from synthetic two-pointer sequences; ink render from a
        known stroke; capability gating hides Workspace-only nodes
  manual: iOS Safari and Android Chrome, verified by behavior not compilation

Risks
  Medium. HiiRoot is 1299 lines; gating must not regress Workspace.
  Mitigation: gate by prop, add tests to the Workspace path first.
  iOS Safari intercepts some gestures — `touch-action: none` is already set
  in app/globals.css:38, which helps.

Explicit non-goals
  No rotate gesture (the field exists; the gesture can wait). No offline
  service worker. No mobile-specific canvas implementation.
```

---

## Tier 2 — More than one person

### T6 · Realtime object channel

```text
Objective
  WebSocket at /api/spaces/:id/events carrying object.create / object.move /
  object.update / object.delete. Two phones on one LAN see each other's changes.

Why it is needed
  P2. No incremental channel exists; transport is a 180 ms whole-document write.

Existing code to reuse
  lib/server/operational-graph-mutations.ts — applyGraphMutation already
    provides lamport total ordering per space, idempotency keys, optimistic
    concurrency against a stated version, and the semantic-vs-projection version
    split that makes "moved" distinguishable from "edited". This is the write path.
  lib/server/operational-object-store.ts    — the four tables, all keyed by space_id
  lib/workspace/rebase.ts                   — the tested three-way merge, for the
                                              whole-document fallback. First caller.
  `ws` (already a dependency)

Files/packages likely affected
  lib/spaces/host/events.ts     (new)
  lib/spaces/protocol.ts        (new) — the wire vocabulary
  components/spaces/useSpaceTransport.ts (new)
  components/workspace/useWorkspace.ts   — accept a transport
  tests/unit/spaces-protocol.test.ts, spaces-events.test.ts (new)

Dependencies
  T2, T5

Acceptance criteria
  - Two browsers on one LAN: an object created in A appears in B without reload
  - Move, update, delete all propagate
  - A reconnecting client resyncs from a snapshot + lamport cursor
  - Concurrent moves converge (last-writer-wins by lamport) without an object
    being lost or duplicated
  - A malformed or oversized frame closes the connection; it never crashes the host
  - For spaces, canonical_source is 'graph'; Workspace stays 'workspace-json'

Tests
  unit: protocol encode/decode; ordering; idempotent replay; oversized frame
  integration: two headless clients against a real host, asserting convergence
  manual: two physical phones

Risks
  Medium. Dual write paths (graph for Spaces, JSON for Workspace) must not
  drift. Mitigation: the host is the ONLY writer for a Space; the JSON document
  is regenerated from the graph, never edited alongside it.

Explicit non-goals
  No CRDT. No operational transform. No cursors (T8). No offline queue.
```

### T7 · Durable Space state through restart

```text
Objective
  Restart the host process and the machine; reopen the Space; identical objects.
  (P3, and steps 20-21 of the §10 demo.)

Why it is needed
  Local ownership is the product's foundation. Desktop persistence already
  works; the host path is new and must be proven by an actual restart.

Existing code to reuse
  lib/server/workspace-store.ts (atomic + locked), the graph store,
  ~/.hii/workspace/assets/<space_id>/

Files/packages likely affected
  lib/spaces/host/server.ts (startup rehydration), scripts/hii-spaces-restart-smoke.mjs (new)

Dependencies
  T6

Acceptance criteria
  - kill -9 the host, restart, reopen: identical object set, positions, blobs
  - Machine restart: same
  - A partially written document is recovered, not lost
  - The lamport cursor resumes without collision (the UNIQUE index proves it)

Tests
  smoke: scripted create -> mutate -> SIGKILL -> restart -> deep-equal
  manual: full machine restart

Risks
  Low-medium. The UNIQUE(space_id, lamport) index will surface any resume bug
  loudly rather than silently — that is desirable.

Explicit non-goals
  No backup, no history browsing, no export.
```

---

## Tier 3 — The distribution loop

### T8 · Guest identity and participant presence

```text
Objective
  Scanning a QR grants immediate participation with an ephemeral guest_<id>.
  Participants see who else is present. No account. (P4.)

Existing code to reuse
  operational_operations.actor_id / device_id (already columns) for durable
  attribution of a guest's contributions.
  Naming: use "participant presence" — "presence" is taken (cli/src/presence.rs).

Files/packages likely affected
  lib/spaces/guest.ts, lib/spaces/host/presence.ts (new)
  components/spaces/PresenceBar.tsx (new)

Dependencies  T6
Acceptance
  - Opening /s/:id with no account issues guest_<random> and a signed per-space token
  - The token authorizes editing only that guest's own objects
  - Participants appear and disappear within seconds of join/leave
  - Presence is never written to disk
  - A guest's objects survive their session; the guest identity does not
Tests  unit: token issue/verify, ownership check, expiry; integration: two clients
Risks  Low. Guard: the token must be scoped to one space and must not be a bearer
       credential for anything else.
Non-goals  No accounts, no profiles, no avatars, no nicknames beyond a color/animal.
```

### T9 · Policy enforcement and the definition of "local"  ← second-highest uncertainty

```text
Objective
  LOCAL ONLY and PUBLIC READ / LOCAL WRITE enforced on every write. (P9,
  step 19 of the demo.)

Why the uncertainty matters
  "Local" cannot be honestly derived from an IP address. The one thing the host
  CAN know reliably is which listener a connection arrived on: the LAN socket or
  the tunnel. That is a real, explainable distinction — and the brief permits
  local-network membership as a participation primitive *provided it is
  represented as exactly that*.

Existing code to reuse
  object-grants.ts / governed-objects.ts — scope evaluation vocabulary
  Space.policy from T1

Files/packages likely affected
  lib/spaces/policy.ts (new), lib/spaces/host/{routes,events,blobs}.ts

Dependencies  T1, T6, and T11 for the public half
Acceptance
  - Policy is evaluated on EVERY write: HTTP, WebSocket, and blob upload
  - A tunnel-origin connection cannot write under PUBLIC READ / LOCAL WRITE
  - The UI states "on this Wi-Fi network", never "here" or "verified present"
  - Changing policy takes effect on live connections without a restart
  - Default for a new Space is the most restrictive: local read, local write
Tests  unit: matrix of (origin × policy × operation) with an injected origin;
       integration: a tunnel-origin client is refused a write
Risks  HIGH of over-claiming. Mitigation: the copy is part of the acceptance
       criteria, not an afterthought. Never call this physical presence.
Non-goals  No geolocation, no BLE proximity, no attestation. INVITE ONLY and
       HOST FROZEN are T10.
```

### T10 · Host controls

```text
Objective  Remove an object, remove a participant, freeze writes, disable
uploads, set limits, clear the Space. (P6.)
Reuse  deleteWorkspaceNodes (client-side today), the policy engine from T9,
       the grants ledger for an auditable record of host actions
Files  lib/spaces/host/controls.ts, components/spaces/HostPanel.tsx (new)
Dependencies  T8, T9
Acceptance  Each control takes effect on live connections immediately; a
removed participant's socket closes and their token stops verifying; a frozen
Space refuses every write with a clear reason; a report path exists and a
minimal moderation hook is callable.
Tests  unit per control; integration with a live second client
Risks  Low. Guard: host controls must be reachable ONLY from the owner's
device, never from the LAN listener.
Non-goals  No moderation UI, no automated classification, no appeals.
```

### T11 · Internet publication

```text
Objective  One action publishes a locally authoritative Space for remote
viewing, and one action unpublishes it. (P7, steps 16-18.)
Reuse  server/remote-test-core.mjs:185-300 — funnelStartArgs/funnelStopArgs,
  BackendState==Running preflight, port-not-already-claimed check, funnelRoute,
  expectedProxy. Extract; do not import the terminal gateway.
Files  lib/spaces/publication.ts (new), Space.publication (from T1), CLI command
Dependencies  T2, T9
Acceptance
  - Publish updates the Space record with the current public endpoint
  - A remote browser loads the Space read-only under PUBLIC READ / LOCAL WRITE
  - Unpublish revokes the route and clears the record
  - The Space ID is unchanged by publishing — no provider identifier is ever
    embedded in it (architectural requirement, brief §12)
  - Host disconnects from the internet: LAN participants continue uninterrupted
Tests  unit: funnel arg construction, preflight failures, record transitions
  manual: publish, load from cellular data on a device not on the Wi-Fi
Risks  Medium — external dependency on Tailscale being installed and running.
  Mitigation: preflight already exists and reports precisely why it cannot publish.
Non-goals  No custom tunnel, no NAT traversal, no relay, no replica.
```

### T12 · QR and the create loop

```text
Objective  Create Space -> name it -> stable ID -> access URL -> QR, in one
screen. Visitors see "create your own space". (P5, P19, steps 2-5.)
Reuse  space-store createSpace; validateWorkspaceId for URL safety
Files  lib/spaces/access-link.ts, components/spaces/CreateSpace.tsx,
  components/spaces/SpaceQr.tsx (new); a QR encoder dependency
Dependencies  T1, T2
Acceptance  Creating a Space surfaces the QR immediately with no configuration
screen in between; scanning it on a phone opens the Space; the URL is stable
across publish/unpublish; the visitor surface carries a create CTA.
Tests  unit: URL construction for local vs published; QR encodes exactly the URL
  manual: scan with a real phone camera
Risks  Low. Choose a QR library with no network access and an acceptable license
  (the repo runs `npm run licenses:check`).
Non-goals  No branded/custom QR, no short links, no deep links into native apps.
```

---

## Tier 4 — Only after the loop works

### T13 · Public `/s/:space_id` resolution  — BLOCKED on an owner decision

```text
Objective  humaninformationinterface.com/s/:id resolves to the Space's current
publication, independent of which machine hosts it. (P8.)
Blocker  The live site is a SvelteKit build whose source is in archive/ and
which cannot be produced from this repository (`ls src` and `ls .svelte-kit`
both absent; wrangler.jsonc points at .svelte-kit/cloudflare). See
SPACES_ARCHITECTURE.md §8. Recommendation: a separate small Worker for
/spaces, /new, /s/:id, leaving the live homepage untouched.
Dependencies  T11 + the decision
Non-goals  No replica, no cache, no proxying of Space content through HII's
infrastructure.
```

### T14 · `/spaces` product page
Depends on T12 and a working demo. The brief's minimum copy is already written
(§18). Interactive demonstration over marketing copy. Do not redesign the
homepage.

### T15–T17 · Deferred
Account claiming (P10), remote replica/cache (P11), analytics (P12), billing
(P13), native HII networking (P14). None should be started before the §10
sequence runs end to end.

---

## Repository hygiene, tracked alongside

Not blockers, but they will cost more the longer they are left:

```text
H1  Decide what humaninformationinterface.com serves (blocks T13)
H2  Rename ci.yml's "Svelte check + Vitest" job — it runs tsc
H3  Retire or repoint wrangler.jsonc and scripts/prepare-cloudflare-public.mjs
H4  Work down the 26 quarantined test files in vitest.config.ts.
    Never add a Spaces test to a quarantine list.
H5  Adopt the vocabulary in SPACES_ARCHITECTURE.md §7 in docs before any
    symbol renames
H6  Reconcile the two workspace-file implementations (Rust unlocked vs TS locked)
    once the host is the only multi-writer
```

---

## Dependency graph

```text
T1 Space record ─┬─> T2 LAN host ─┬─> T4 blobs ──┐
                 │                 │              ├─> T5 touch canvas ─> T6 realtime ─> T7 durable
                 │                 └─> T12 QR     │                          │
                 │                                │                          ├─> T8 guests
                 └─> T9 policy <──────────────────┘                          │
                          │                                                  │
T3 object model ──────────┴──────────────────────────────────────────────────┘
                                                     T9 + T8 ─> T10 host controls
                                                     T2 + T9 ─> T11 publication ─> T13 public route [BLOCKED]
```

**Start with T1.** It is unblocked, it is the primitive every other task
references, and it is small enough to finish and verify in one pass.
#### T13 execution update (2026-08-20)

The owner approved the separate path-scoped Worker and preview deployment.
`workers/spaces-public/` now provides isolated preview and fail-closed production
entries, strict public projections, route-collision tests, and executable dry
builds. The workers.dev preview is verified. Production route attachment is not
authorized; it additionally depends on replacing the fail-closed resolver with
a reviewed provider-neutral publication resolver. Exact topology, commands,
and rollback are recorded in `docs/SPACES_PRODUCTION_TOPOLOGY.md`.
