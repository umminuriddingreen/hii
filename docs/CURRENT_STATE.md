# HII — Current State

**Audit date:** 2026-08-20
**Commit:** `54ac1049` (branch `main`)
**Method:** executable-code inspection plus commands actually run on this machine.
Nothing below is taken from a README, comment, TODO, ADR, or prior plan.

## Implementation checkpoint — Wave 1

After the audit baseline below, T1, T2, and T3 were implemented in the current
working tree. HII now has a durable canonical Space record, an explicit
Space-only LAN host with a loopback-safe default, and additive Space metadata
on the existing `WorkspaceNode` model. The host was exercised on this Mac's
physical `en0` interface at `100.100.86.2/25`: both `/s/lan-proof` and
`/api/spaces/lan-proof` returned HTTP 200. A physical second-device smoke test
is still required before claiming phone reachability.

Current verification after Wave 1: 69 Vitest files / 470 tests passed,
TypeScript check and lint passed sequentially, the static web build passed,
386 Rust CLI tests passed, Space and Workspace persistence smokes passed, and
the secret scan passed.

Wave 2 adds a Space-scoped, image-only blob path and a reduced touch-oriented
Space projection over the same canvas. A real LAN smoke uploaded, retrieved,
restarted the host, and retrieved the same opaque blob reference again. The
post-Wave-2 gate passed 75 Vitest files / 489 tests plus build, typecheck, lint,
Space/Workspace smokes, and secret scan. Physical phone gestures are not yet
verified.

Waves 3-5 add host-authoritative WebSocket object synchronization, SIGKILL
restart recovery, shared Rust/TypeScript workspace locking, ephemeral guest
identity and presence, canonical policy enforcement, process-local host
controls, a loopback-only operator surface, offline QR generation, and a
provider-neutral publication controller with a separately scoped public
listener. No real Funnel or production deployment was performed.

Current integrated gate: production build, typecheck, lint, 88 Vitest files /
560 tests, 386 Rust tests, Space identity/restart smokes, Workspace regression
smoke, and secret scan pass. `npm audit --omit=dev` remains red for high-severity
advisories affecting the current Next/PostCSS/Nanoid dependency lines; the
required Next fix is a breaking major upgrade and has not been applied.

Verification commands run for this audit:

```text
npx vitest run                          -> 66 files, 429 tests, all passed (exit 0)
npm run check         (tsc --noEmit)    -> clean (exit 0)
NEXT_PUBLIC_HII_TARGET=web next build   -> 8 static routes emitted (exit 0)
cargo check --workspace                 -> hii-core, hii-cli, hii-native-runner clean (exit 0)
curl https://www.humaninformationinterface.com/  -> 200, SvelteKit build (see section E)
```

---

## A. Repository map

```text
/
├── app/                    Next.js App Router (static export). 6 pages.
├── components/workspace/   The canonical canvas UI (React). HiiRoot + NodeFrame + useCamera.
├── lib/
│   ├── workspace/          Canvas domain logic: types, selection, ink, ingest, rebase, …
│   ├── client/             hii-bridge.ts — the only client↔runtime boundary.
│   ├── server/             Node-side runtime libraries (SQLite graph, grants, stores).
│   └── operational-graph/  Record shapes for the operational object graph.
├── cli/                    Rust `hii` CLI. 54 modules, main.rs is 5052 lines.
├── crates/hii-core/        Shared Rust: runtime_root, workspace read/write, web capability.
├── src-tauri/              Tauri v2 desktop shell. 20 commands, 597 lines.
├── native-runner/          Rust `hii-native-runner`.
├── macos/                  Swift menu-bar app (HiiBarCore).
├── fabric/                 Cross-device capture: Rust protocol + Windows receiver + Swift capture.
├── browser/                TypeScript governed browser worker.
├── server/                 Standalone Node servers (remote-test gateway, pty gateway).
├── aii/                    Legacy daemon/admin-agent. ADR 004 declares this migration debt.
├── apps/openai-hii/        Separate Express app.
├── scripts/                67 files. Smoke tests, installers, dev runtime, packaging.
├── tests/unit/             94 test files, 26 of them quarantined in vitest.config.ts.
├── archive/2026-08-agent-native-rewrite/   250 files. SvelteKit app + Next API routes + prototypes.
└── docs/                   ADRs and product docs.
```

### Major packages

| Package | Responsibility | Entrypoint | Stack | Actively used | Depended on by |
|---|---|---|---|---|---|
| `app/` | Static Next.js shell; `/` mounts the canvas | `app/page.tsx` | Next 14 App Router, `output: 'export'` | Yes — builds, 8 routes | Tauri (loads the export), `out/` |
| `components/workspace/` | The canvas. Camera, node frames, all node bodies | `HiiRoot.tsx` (1299 lines) | React 18 | Yes — this is the product UI | `app/page.tsx` |
| `lib/workspace/` | Canvas domain logic and object types | `types.ts` | TypeScript | Partly — several modules orphaned (§E) | `components/workspace/`, `lib/server/` |
| `lib/client/hii-bridge.ts` | Client→runtime calls; Tauri IPC or browser fallback | — | TypeScript | Yes — sole boundary | all canvas code |
| `lib/server/` | Node runtime libs: SQLite graph, grants, stores | `operational-object-store.ts` | TS + `node:sqlite` | Partly — reachable only from `scripts/*.mjs` and tests, **not** from the shipping app | `scripts/hii-*.mjs`, tests |
| `crates/hii-core` | Rust runtime root, workspace file I/O | `lib.rs` | Rust | Yes | `cli/`, `src-tauri/`, `native-runner/` |
| `cli/` | The `hii` binary — ADR 004 runtime owner | `main.rs` | Rust, clap | Yes — compiles clean | Tauri shells out to it |
| `src-tauri/` | macOS/Windows desktop shell | `lib.rs` | Rust, Tauri v2 | Yes | packaged app |
| `server/remote-test-*` | Public remote terminal/artifact gateway over Tailscale Funnel | `remote-test-gateway.mjs` | Node, `ws`, `node-pty` | Standalone; not wired to the canvas | `scripts/hii-remote-test.mjs` |
| `archive/…` | The previously-shipped SvelteKit site and deleted Next API routes | — | Svelte | **Not built — but is what production currently serves** (§E) | nothing in-tree |

---

## B. What is definitely working

### Static web build

```text
Feature: Next.js static export of the HII surface
Status: WORKING
Evidence:
- app/page.tsx, app/layout.tsx, app/{docs,download,privacy}/page.tsx
- next.config.mjs: output: 'export'
- Command: NEXT_PUBLIC_HII_TARGET=web npx next build
- Result: 8 routes prerendered; `/` is 29.4 kB / 117 kB first load
Notes: There are zero API routes. `output: 'export'` forbids them.
```

### Typecheck and test suite

```text
Feature: TypeScript + unit test gates
Status: WORKING
Evidence:
- Command: npm run check   -> tsc -p tsconfig.json --noEmit, clean
- Command: npx vitest run  -> 66 files / 429 tests passed in 2.77s
- vitest.config.ts
Notes: 26 of 94 test files are explicitly quarantined (`svelteKitFossils`,
`apiRouteFossils`, `packagingFossils`). The green result covers 68 files.
The config documents this honestly.
```

### Rust workspace

```text
Feature: hii CLI, hii-core, native runner compile
Status: WORKING
Evidence:
- Command: cargo check --workspace -> Finished dev profile, no warnings surfaced
- cli/src/main.rs (5052 lines, ~40 top-level clap subcommands)
- crates/hii-core/src/lib.rs
Notes: `hii` is the runtime owner per ADR 004 and Tauri shells out to it.
```

### Canvas camera, drag, selection, delete, undo

```text
Feature: Spatial canvas interaction
Status: WORKING
Evidence:
- components/workspace/useCamera.ts — pan via pointer events, zoom via
  ctrl/meta + wheel, world<->screen transform, viewport persistence
- components/workspace/NodeFrame.tsx:25-62 — pointer drag to move,
  Alt+drag to resize, commits to the document on pointerup
- components/workspace/HiiRoot.tsx:1165 — Delete/Backspace removes selection
- components/workspace/useWorkspace.ts:76-90 — undo/redo over an 80-step
  node-array history
- lib/workspace/selection.ts — marquee, lasso, duplicate, nudge, link/unlink
- tests/unit/workspace-selection*.test.ts and 65 other passing files
Notes: All pointer-based, so it responds to touch. See §4 for what that
does and does not mean on a phone.
```

### Desktop persistence

```text
Feature: Canvas state survives desktop app restart
Status: WORKING
Evidence:
- src-tauri/src/lib.rs:30-38 — workspace_read / workspace_write commands
- crates/hii-core/src/lib.rs:91-95 — workspace_path() resolves
  ~/.hii/workspace/workspaces/<selected>.json
- crates/hii-core/src/lib.rs:74-90 — selected_workspace_id() reads
  ~/.hii/workspace/selection.json, defaulting to "default"
- crates/hii-core/src/lib.rs:122-138 — write validates version/nodes/viewport,
  bumps revision, atomic_json_write
- lib/client/hii-bridge.ts:135-153 — routes to Tauri IPC when
  __TAURI_INTERNALS__ is present
Notes: The on-disk layout is ALREADY per-workspace-id. This is the single
most important reusable fact for Spaces.
```

### Blob storage on desktop

```text
Feature: Files/images stored durably outside the JSON document
Status: WORKING (desktop only)
Evidence:
- src-tauri/src/lib.rs:89-106 — workspace_asset_store, 1 byte .. 250 MB,
  writes ~/.hii/workspace/assets/<run-id>-<safe-name>
- src-tauri/src/lib.rs:~80 — safe_asset_name() sanitizes and truncates to 160 chars
- lib/workspace/ingest.ts:234-244 — Tauri path invokes it and returns
  a convertFileSrc URL
Notes: Web has no equivalent. See §C.
```

### Operational object graph (SQLite)

```text
Feature: Versioned object/relation/operation store keyed by space_id
Status: WORKING as a library
Evidence:
- lib/server/operational-object-store.ts:55-141 — four tables:
  operational_objects, operational_relations, operational_operations,
  object_projections. Every one carries space_id.
- operational_operations has actor_id, device_id, lamport (UNIQUE per space),
  idempotency_key (UNIQUE partial index), authority_grant_id, operation_hash
- lib/server/operational-graph-mutations.ts:242 applyGraphMutation — optimistic
  concurrency against a stated version; 719 readOperationHistory
- lib/operational-graph/types.ts — three independent version domains
  (semantic / projection / relation), closed RelationType vocabulary
- Tests: tests/unit/operational-object-store.test.ts,
  operational-graph-mutations.test.ts, agentic-artboard-integration.test.ts
- DB path: ~/.hii/hii.db (HII_DB_PATH override), WAL, foreign keys on
Notes: `canonical_source` defaults to 'workspace-json' — the graph is
currently a PROJECTION of the JSON document, not the source of truth.
This library is not reachable from the shipping desktop app; only from
Node scripts and tests.
```

### Object grants / authority ledger

```text
Feature: Append-only capability grants scoped to (space, objects, operations)
Status: WORKING as a library
Evidence:
- lib/server/object-grants.ts — JSONL ledger at ~/.hii/grants/*.jsonl,
  approve / revise / revoke / moveTerritory, status lifecycle
  active|superseded|revoked|expired, grantToScope()
- lib/server/governed-objects.ts:404 readOnlyScope(spaceId, objectIds, runId)
- lib/server/governed-objects.ts — list/read/create/patch/annotate/tombstone
  all take an ObjectAccessScope
- Tests: tests/unit/object-grants.test.ts, governed-objects.test.ts
Notes: Designed for agent authority, not visitor authority — but the
shape (subject × space × objects × operations × expiry) is exactly what
a Space permission policy needs.
```

### Multi-workspace store (Node side)

```text
Feature: Create / list / select named workspaces with locking
Status: WORKING as a library
Evidence:
- lib/server/workspace-store.ts:300 lines — validateWorkspaceId
  (1-64 chars, ^[a-z0-9][a-z0-9_-]*[a-z0-9]$), workspacePath(),
  atomicWriteFile + withFileLock, WorkspaceRevisionConflictError,
  WorkspaceNotFoundError, preserveUnreadable() recovery
- Command: npm run hii:workspace:check (scripts/hii-workspace-store-smoke.mjs)
- Consumers: scripts/hii-launch-proof-workspace.mjs, lib/server/context-refs.ts,
  lib/server/workspace-variant.ts, lib/server/hii-voice-workspace-context.ts
Notes: Shares the on-disk layout with the Rust reader, so the two agree
about where a workspace lives. The Rust side can read a selected id but
exposes no create/list/switch to the UI.
```

### Public remote gateway over Tailscale Funnel

```text
Feature: Expose a local service to the public internet with auth + rate limits
Status: WORKING (for remote terminal/artifacts, not for the canvas)
Evidence:
- server/remote-test-core.mjs:185-300 — funnelRoute, funnelStartArgs
  (`tailscale funnel --bg --yes --https=<port> <proxy>`), funnelStopArgs,
  preflight checks for BackendState==Running and port-not-occupied
- server/remote-test-gateway.mjs — WebSocketServer, SlidingWindowLimiter,
  MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_MINUTE, DISCONNECT_GRACE_MS,
  newSecret(), routeOwnedBy(), session layout, artifact allowlist
  (/\.(html|png|jpe?g|gif|webp|svg|txt|md|json)$/i)
- Ports: TERMINAL_PORT 17171, ARTIFACT_PORT 17172, HTTPS 443 / 8443
- Tests: tests/remote-test-gateway.test.mjs (runs under node --test, not vitest)
Notes: This is a working precedent for §12 internet publication that
does not require building NAT traversal.
```

---

## C. Partially implemented

```text
Feature: The canvas in a plain web browser
Status: PARTIAL

Exists:
- The full canvas UI renders. `next build` emits it at `/`.
- lib/client/hii-bridge.ts:140-146 — readWorkspace falls back to
  localStorage key 'hii.workspace.v2'
- writeWorkspace mirrors to the same key.

Missing:
- Any server. State is per-browser-profile and invisible to anyone else.
- Blob storage. lib/workspace/ingest.ts:245-247 POSTs uploads to
  /api/workspace/assets, a route that DOES NOT EXIST — `output: 'export'`
  cannot have one, and the handler lives in
  archive/…/legacy-next-api/api/workspace/assets/route.ts.
  storeWorkspaceAsset() therefore returns null and ingest.ts:387-389
  falls back to URL.createObjectURL(file) with ephemeral: true.
  Every image dropped on the web canvas dies on refresh.
- Agent runs point at http://127.0.0.1:3043 (hii-bridge.ts:107-112),
  a dev-only shim (scripts/hii-web-dev-runtime.mjs, CORS hardcoded to
  port-1). Not present in production.

Evidence: the three files above, plus `ls out/` (no API output).
```

```text
Feature: Multi-workspace as a user-facing concept
Status: PARTIAL

Exists:
- On-disk layout ~/.hii/workspace/workspaces/<id>.json + selection.json
- Rust reads the selected id (crates/hii-core/src/lib.rs:74-95)
- TypeScript can create/list/select (lib/server/workspace-store.ts)

Missing:
- No Tauri command to create, list, or switch a workspace.
  src-tauri/src/lib.rs exposes only workspace_read / workspace_write, and
  crates/hii-core write_workspace() writes to the selected path with no id argument.
- No UI affordance anywhere in components/workspace/.
- The two implementations of the same file format do not share code, and
  only the TypeScript one takes the file lock.

Evidence: src-tauri/src/lib.rs (20 commands, none for workspace lifecycle);
grep for createWorkspace in components/ returns nothing.
```

```text
Feature: Save-conflict merge
Status: PARTIAL

Exists:
- lib/workspace/rebase.ts — a correct, well-documented three-way merge of
  nodes and links with delete-vs-edit resolution, verified by
  tests/unit/workspace-rebase.test.ts

Missing:
- No caller. `rg -l "lib/workspace/rebase"` outside archive/node_modules
  returns exactly one file: its own test.
- useWorkspace.ts:31-39 swallows every write failure ("The next mutation
  retries") and never attempts a rebase.

Evidence: the grep above; useWorkspace.ts persist().
```

```text
Feature: Freehand ink / drawing
Status: PARTIAL

Exists:
- lib/workspace/ink.ts — stroke model (flat [x,y,…]), Douglas–Peucker
  simplification, INK_MAX_POINTS 4000 guard, padding, defaults
- 'ink' is a declared WorkspaceNodeType (lib/workspace/types.ts:12)
- tests/unit/workspace-ink.test.ts passes
- HiiRoot.tsx:1253 treats 'ink' as chromeless

Missing:
- No renderer and no capture surface. The node-body switch in
  HiiRoot.tsx:321-351 has no 'ink' branch, so an ink node falls through
  to `<pre className="hii-node-copy">`.
- No import of lib/workspace/ink.ts outside its own test.
- The drawing UI that existed (archive/…/legacy-svelte/…/InkPane.svelte)
  was not ported.

Evidence: the grep and the switch statement above.
```

```text
Feature: Agent runs from the canvas
Status: PARTIAL

Exists:
- src-tauri/src/lib.rs:221 agent_start / 367 agent_cancel, streaming
  hii://agent-event to the webview
- The `hii run --jsonl --stream --autonomy local-full --authority <…>` contract
- scripts/hii-web-dev-runtime.mjs mirrors it over HTTP for `npm run dev`

Missing:
- Web production has no runtime to talk to.

Evidence: hii-bridge.ts startAgent(); next.config.mjs.
```

---

## D. Not implemented

```text
Feature: Realtime multiplayer on the canvas
Status: ABSENT

Search performed:
  rg -l "WebSocket|ws://|EventSource|text/event-stream|socket.io" \
     --glob '!node_modules' --glob '!archive' --glob '!out' --glob '!.next' .
Hits: server/remote-test-*.mjs, server/pty-sessions.mjs,
      server/remote-test-static/app.js, lib/server/hii-chromium.ts,
      scripts/hii-codex-threads.mjs

Why it is considered absent: every hit belongs to the remote-terminal
gateway, the PTY bridge, or Chromium DevTools. None is imported by
components/workspace/ or lib/client/. The canvas transport is a whole-document
read/write (useWorkspace.ts persist()) with a 180 ms debounce — there is no
incremental channel of any kind.
```

```text
Feature: LAN-reachable server
Status: ABSENT

Search performed:
  rg -n "listen\(|0\.0\.0\.0" over *.mjs *.ts *.rs excluding node_modules/archive/target
Result: every single listen() call binds '127.0.0.1'. Zero occurrences of
'0.0.0.0' anywhere in the tree.

Why it is considered absent: nothing in HII can currently be reached from
another device on the same Wi-Fi. Tailscale Funnel (§B) proxies to loopback,
so it is an internet path, not a LAN path.
```

```text
Feature: Guest / visitor identity
Status: ABSENT

Search performed: rg -i "guest" over cli/, lib/, components/, app/
Result: no guest identity type, no anonymous session issuance, no
account-free join path.

Why it is considered absent: cli/src/identity.rs and the HII Link contact
card (`link card --json`, hii-bridge HiiContactCard) are signed *operator*
identity with a public key. `cli/src/presence.rs` is a projection of the
operator's own continuity/attention/authority — it has nothing to do with
multi-user presence. Both are single-owner concepts.
```

```text
Feature: Space as a first-class domain object
Status: ABSENT

Search performed: git ls-files | grep -i space; rg "space_id|spaceId"
Result: `space_id` exists as a COLUMN on all four operational-graph tables
and as `spaceId` on the record types, and `readOperationalSpace()` /
`OperationalSpaceSnapshot` read by it. But:
- there is no `spaces` table and no Space record anywhere;
- space_id is populated by projectWorkspaceIntoOperationalGraph(spaceId, …)
  from the caller's workspace id;
- `scripts/hii-space.mjs` and `cli` "space" naming refer to macOS AeroSpace
  window-manager workspaces (scripts/hii-space-smoke.mjs asserts
  `AeroSpace 0.19.2`, `list-workspaces --all`), which is an unrelated concept.

Why it is considered absent: a Space today has no owner, no metadata, no
permission model, no hosting state, no publication state, and no identity
independent of a filename.
```

```text
Feature: QR generation / access links
Status: ABSENT
Search performed: rg -i "qrcode|qr_code|\bQR\b" excluding node_modules/archive
Result: no generator, no dependency, no route.
```

```text
Feature: Upload safety controls for untrusted input
Status: ABSENT

Search performed: rg -i "mime|content-disposition|rate.?limit|exif|strip"
Result: rate limiting exists ONLY in server/remote-test-gateway.mjs
(SlidingWindowLimiter) for the remote terminal. On the canvas path,
workspace_asset_store enforces a 250 MB cap and filename sanitization and
nothing else: no MIME allowlist, no image-dimension limit, no EXIF
stripping, no per-space quota, no Content-Disposition control.

Why it is considered absent: that surface has only ever accepted input from
the machine's own owner. It is not safe to expose to public uploads as-is.
```

```text
Feature: Accounts / authentication
Status: ABSENT (for the product surfaces)
Search performed: rg -i "supabase|session|login|oauth" in lib/, app/, components/
Result: lib/server/supabase.ts exists; docs/auth-providers.md exists.
No auth is wired into app/ or components/. The static export has no session concept.
```

```text
Feature: Public /s/:space_id route
Status: ABSENT
Search performed: find app -type f; curl the live domain (§E)
Result: neither the repo's Next app nor the deployed site has /spaces, /new, or /s/*.
```

---

## E. Dead / duplicated / obsolete architecture

**Nothing here has been deleted.** Each item is recorded with the evidence
that makes it dead or duplicated.

### 1. Production serves an app whose source is archived — highest-severity finding

`curl -L https://www.humaninformationinterface.com/` returns 200 with
`__sveltekit` and `/_app/immutable/` in the markup, `<title>HII — Verified
agent work, grounded in your context</title>`, and links to `/architecture`,
`/learn`, `/download/windows`, `/privacy`.

The repository contains no SvelteKit source: `ls src` → no such directory;
the routes live in `archive/2026-08-agent-native-rewrite/legacy-svelte/src/`.
`ls .svelte-kit` → no such directory.

Consequences that follow directly:
- `wrangler.jsonc` `main` = `.svelte-kit/cloudflare/_worker.js` and `assets.directory`
  = `.svelte-kit/cloudflare` — both point at a path that cannot be produced.
- `scripts/prepare-cloudflare-public.mjs` cleans that same nonexistent directory.
- The Next.js `out/` build (which contains the canvas) is not what is deployed.
- `.github/workflows/ci.yml` names its job "Svelte check + Vitest" while
  `npm run check` is now `tsc --noEmit`.
- 23 test files in `svelteKitFossils` assert against `src/routes/**` and
  `src/hooks.ts`; they are excluded in `vitest.config.ts`, which is why the
  suite is green.

**The live site cannot currently be changed from this repository.**

### 2. Two object systems for the same objects

- `WorkspaceDoc.nodes` in `~/.hii/workspace/workspaces/<id>.json` — authoritative.
- `operational_objects` in `~/.hii/hii.db` — a projection, `canonical_source`
  defaults to `'workspace-json'`, written by
  `projectWorkspaceIntoOperationalGraph()` (operational-object-store.ts:207).

ADR 002 states the intended direction (graph becomes canonical) and that the
migration is "in progress". As of this commit the shipping desktop app never
touches the graph at all: `src-tauri/src/lib.rs` calls
`hii_core::write_workspace`, which is pure JSON I/O.

### 3. Two implementations of the workspace file format

`crates/hii-core/src/lib.rs` (Rust, no lock, single selected id) and
`lib/server/workspace-store.ts` (TypeScript, `withFileLock`, revision-conflict
detection, id validation, corruption recovery). They read and write the same
files with different guarantees. The Rust path is what the desktop app uses;
the safer one is unreachable from it.

### 4. Orphaned modules with passing tests

| Module | Only consumer | Note |
|---|---|---|
| `lib/workspace/rebase.ts` | `tests/unit/workspace-rebase.test.ts` | Correct merge, no caller |
| `lib/workspace/ink.ts` | `tests/unit/workspace-ink.test.ts` | No renderer (§C) |
| `lib/landing.ts` | nothing | Musician landing-page template; comments reference a `/landing` route that does not exist |

### 5. Stale build/deploy configuration

`wrangler.jsonc`, `scripts/prepare-cloudflare-public.mjs`, and the `ci.yml`
job name, all per item 1.

### 6. Unported prototypes

`archive/2026-08-agent-native-rewrite/prototypes/react-canvas/` and
`capability-packs/canvas-specialists/` contain a near-duplicate of
`components/workspace/` (HiiRoot, NodeFrame, useCamera, usePtySocket, nodes/*).
`components/workspace/` is the one that ships.

### 7. Migration debt named by ADR 004

`aii/` (daemon, admin-agent, codex, skills, capabilities) — ADR 004 says this
should live behind CLI-owned modules. `components/SurfaceDisabled.tsx` still
instructs users to run `hiid config set …`.

### 8. Naming collisions to resolve before building Spaces

| Term | Existing meaning | File |
|---|---|---|
| **space** | macOS AeroSpace window-manager workspace | `scripts/hii-space.mjs`, `scripts/hii-space-smoke.mjs` |
| **space_id** | Operational-graph partition key = workspace id | `lib/server/operational-object-store.ts` |
| **presence** | Operator continuity/attention/authority projection | `cli/src/presence.rs` |
| **workspace** | (a) canvas document (b) agent working directory (c) npm/cargo workspace | throughout |

---

## Canvas capability matrix

Legend: ● yes · ◐ partial · ○ no.
"Persistent" and "Multiplayer" are judged against the shipping desktop app;
where web differs it is called out.

| Capability | Exists | Reliable | Mobile | Persistent | Multiplayer |
|---|---|---|---|---|---|
| pan | ● | ● | ◐ one-finger drag works (pointer events); no momentum, no bounds | ● viewport saved | ○ |
| zoom | ● | ● | ○ **wheel + ctrl/meta only — no pinch handler** | ● | ○ |
| text object | ● `note` / `canvas-text` | ● | ◐ textarea works; no mobile toolbar | ● | ○ |
| image object | ● | ● desktop | ○ no camera capture, no file picker button | ● desktop · ○ web (blob: URL) | ○ |
| file object | ● `file`/`document`/`cad`/`model` | ● desktop | ○ | ● desktop · ○ web | ○ |
| drawing | ◐ model + tests only, **no UI** | ○ | ○ | ○ | ○ |
| sticker | ○ not a type | ○ | ○ | ○ | ○ |
| video | ● `media` | ● desktop | ◐ plays; no capture | ● desktop · ○ web | ○ |
| drag | ● | ● | ● pointer events cover touch | ● | ○ |
| resize | ● **Alt+drag only** | ● | ○ no touch equivalent, no handle | ● | ○ |
| rotate | ○ no field on `WorkspaceNode`, no handler | ○ | ○ | ○ | ○ |
| selection | ● click, marquee, lasso, multi | ● | ◐ tap selects; marquee needs a drag mode | n/a client-only | ○ |
| object deletion | ● Delete/Backspace | ● | ○ **no on-screen delete control** | ● | ○ |
| persistence | ● desktop JSON + assets | ● atomic write, revision bump | ● whatever the surface does | ● | ○ |
| realtime sync | ○ | ○ | ○ | ○ | ○ |
| presence | ○ (the word means something else here) | ○ | ○ | ○ | ○ |
| phone usability | ◐ layout is responsive-ish; interaction is not | ○ | ○ | — | ○ |

### Answers

1. **Canonical canvas implementation** — `components/workspace/` (`HiiRoot.tsx`,
   `NodeFrame.tsx`, `useCamera.ts`, `useWorkspace.ts`) over `lib/workspace/`.
   Everything under `archive/` is superseded.
2. **Object model** — `WorkspaceNode` (`lib/workspace/types.ts:110-137`):
   `id, type, x, y, w, h, z, createdAt, updatedAt, payload` plus optional
   `object` (SpatialObjectMetadata), `objectRef`, `frameId`. 26 node types.
   No `rotation`, no `spaceId`, no creator, no permissions.
3. **UI-state or object/event oriented?** — Object-oriented in shape,
   **document-oriented in transport**. The whole `WorkspaceDoc` is written on
   a 180 ms debounce (`useWorkspace.ts:41-45`). There is no
   `object.create`/`move`/`update`/`delete` wire format on this path — although
   `applyGraphMutation` in `lib/server/operational-graph-mutations.ts`
   *is* exactly that, unused by the UI.
4. **Durable?** — Yes on desktop (`~/.hii/workspace/workspaces/<id>.json`,
   atomic, revision-bumped; assets in `~/.hii/workspace/assets/`).
   No on web (localStorage, blob URLs).
5. **Independent of the desktop app?** — Yes structurally. `HiiRoot` renders in
   any browser and `hii-bridge` already branches on `__TAURI_INTERNALS__`.
   What is missing is a server on the non-Tauri branch, not a UI decoupling.
6. **Mobile browser?** — It loads and lays out. It is not usable: no pinch-zoom,
   no touch resize, no on-screen delete, no camera intake.
7. **Multiple clients on one state?** — No. Two tabs on the same desktop
   overwrite each other; `rebase.ts` would fix that and is not called.
8. **What must change for Spaces?** — A Space record with identity/owner/policy;
   a server that binds to the LAN; an incremental object-event channel;
   guest identity; blob storage on the non-Tauri path; touch interaction;
   upload safety.
9. **Can Workspace and Spaces share the object model?** — Yes, and they should.
   `WorkspaceNode` needs three additive fields (`spaceId`, `creatorId`,
   `rotation`) and the four Spaces types (`image`, `text`, `sticker`, `drawing`)
   map onto existing types — `image` ●, `canvas-text` ●, `ink` ◐, sticker is
   an `image` with a payload flag. Nothing needs to be replaced.

---

## Website

**Deployed (`https://www.humaninformationinterface.com/`)** — SvelteKit on
Cloudflare Workers. Confirmed live routes: `/` (200), `/privacy` (200).
Confirmed 404: `/docs`, `/download`, `/spaces`, `/new`, `/s/:id`.
Markup links to `/architecture`, `/learn`, `/download/windows`.
Metadata: `<title>HII — Verified agent work, grounded in your context</title>`;
description "HII is a local-first workspace and native CLI for source-linked
context, bounded agent work, proof, and durable receipts."
Positioning today is entirely Workspace. **Its source is in `archive/`.**

**In-repo (`app/`)** — Next.js static export, 6 pages: `/` (the canvas),
`/docs`, `/download`, `/privacy` (each ~10 lines), plus `/icon.svg` and
`/_not-found`. No analytics, no auth, no API, no design system beyond
`app/globals.css` + `app/apps.css`. R2 bucket `hii` is bound as `DOWNLOADS`
in `wrangler.jsonc` for release assets.

**Gap:** the deployable web app and the deployed web app are different
applications. Adding `/spaces`, `/new`, `/s/:space_id` requires first deciding
which one production serves — and `/s/:space_id` cannot be a static export at all.
## T13 preview state (2026-08-20)

An independent, binding-free Cloudflare Worker now lives at
`workers/spaces-public/`. Preview version
`d07bd351-92b9-4b10-a022-587203256858` is live only at
`https://hii-spaces-public-preview.ummingreen.workers.dev`. It serves
`/spaces`, `/new`, and a read-only `14th-street` demonstration projection.
Production `humaninformationinterface.com` remains unchanged and still returns
404 for its Spaces paths. See `docs/SPACES_PRODUCTION_TOPOLOGY.md`.
