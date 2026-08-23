# HII Spaces — Gap Analysis

**Date:** 2026-08-20 · **Basis:** `docs/CURRENT_STATE.md`, `docs/SPACES_ARCHITECTURE.md`

**Wave 1 update:** the stable Space ID, owner, metadata, hosting record, explicit
LAN host, and additive canonical object-model gaps are implemented in the
working tree. T2 has same-machine proof through the real `en0` address and an
independent security review; physical second-device proof remains open. Drawing
rendering, visitor UI, uploads, realtime, guests, policy enforcement, host
controls, QR entry, and publication remain gaps.

**Wave 2 update:** the local image upload/retrieval and reduced mobile surface
gaps are implemented and automated tests pass. Cross-device synchronization,
canonical host-side object persistence, physical-device touch proof, guest
identity, policy enforcement, moderation, QR entry, and publication remain.

**Waves 3-5 update:** realtime, application/SIGKILL restart persistence, guest
entry, participant presence, canonical policies, host controls, offline QR,
operator create/share UI, and provider-neutral publication control are
implemented locally. Remaining proof gaps are physical iPhone/Android and
two-device behavior, a real authorized Funnel/cellular test, machine/power-loss
restart, and the production-domain resolver. The live `/spaces`, `/new`, and
`/s/:id` routes remain 404.

Classification: `READY` · `NEEDS EXTENSION` · `NEEDS REFACTOR` · `MISSING` · `BLOCKED` · `REMOVE/IGNORE`

Requirements are numbered by the §10 critical demo step they serve, or by the
brief section that defines them.

---

## Core primitives

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| Stable Space ID | MISSING | `validateWorkspaceId()` produces URL-safe ids | No Space record; an id is only a filename | Add `~/.hii/spaces/<id>.json`; reuse the validator unchanged | — | **P0** |
| Space owner | MISSING | workspace file has no owner field | — | Field on the Space record | Space record | **P0** |
| Space metadata (name "14th Street") | MISSING | — | — | Field on the Space record | Space record | **P0** |
| Space permission model | NEEDS EXTENSION | `object-grants.ts` + `governed-objects.ts` (subject × space × ops × expiry, with lifecycle) | Agent-shaped, object-scoped, no guest subject, advisory | Add `policy` to the Space record as the source of truth; enforce on the host write path; keep the ledger for derived guest grants | Space record, host | **P0** |
| Hosting / publication state | MISSING | funnel control exists in `remote-test-core.mjs` | No record of intent or current endpoint | Fields on the Space record | Space record | **P0** |
| Space id ↔ workspace id | READY | `~/.hii/workspace/workspaces/<id>.json`, `selection.json`, Rust reader honors both | — | Reuse as-is; do not migrate | — | — |
| Canonical object model | NEEDS EXTENSION | `WorkspaceNode` in `lib/workspace/types.ts` | No `rotation`, `spaceId`, `creatorId` | Three optional fields, additive | — | **P1** |
| Object types Image/Text/Sticker/Drawing | NEEDS EXTENSION | `image` ●, `canvas-text` ●, `ink` model-only, sticker absent | Drawing has no renderer; sticker is not a concept | Render `ink`; sticker = `image` + `payload.sticker` | object model | **P1** |
| Object event vocabulary | NEEDS EXTENSION | `applyGraphMutation` with lamport, idempotency, optimistic concurrency, semantic/projection version split | Not used by the UI; no `object.*` wire names | Name the four operations; wire the host to it | host | **P2** |

## Canvas / mobile

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| Pan on phone | READY | `useCamera.panStart` uses pointer events | One-finger drag works | Verify on device; add bounds | — | **P1** |
| Pinch zoom | MISSING | `useCamera` zooms only on ctrl/meta + wheel | No touch handler at all | Add two-pointer pinch + two-finger pan | — | **P1** |
| Drag object on phone | READY | `NodeFrame.pointerDown` | — | Verify on device | — | **P1** |
| Resize on phone | NEEDS EXTENSION | Alt+drag only | No touch equivalent, no visible handle | Add a corner handle | — | **P1** |
| Rotate | MISSING | no field, no handler | — | Add `rotation` + transform; defer the gesture past MVP if needed | object model | **P1** |
| Delete on phone | NEEDS EXTENSION | Delete/Backspace key only | No on-screen control | Add a selection action bar | — | **P1** |
| Add image from phone camera | MISSING | `ingest.ts` handles dropped files | No file input, no `capture` attribute, no button | Add `<input type=file accept="image/*" capture>` to the Spaces surface | — | **P1** |
| Add text on phone | NEEDS EXTENSION | `note`/`canvas-text` render a textarea | No creation affordance sized for touch | Toolbar button | — | **P1** |
| Drawing surface | MISSING | `lib/workspace/ink.ts` (simplification, caps, tests) but **no renderer and no caller** | Renderer + capture | Wire `ink` into the node-body switch; capture with pointer events | object model | **P1** |
| Spaces-specific reduced surface | NEEDS REFACTOR | `HiiRoot.tsx` is 1299 lines with terminal, browser, marketplace, apps dock | Everything is unconditional | Capability-gate by `surface` prop; do **not** fork the file | — | **P1** |
| Viewport meta | READY | `app/layout.tsx` sets `width=device-width, initialScale=1` | — | — | — | — |

## Networking

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| **LAN-reachable server** | **MISSING** | Every `listen()` in the tree binds `127.0.0.1`; zero occurrences of `0.0.0.0` | No device can reach the host | Build the Spaces host binding `0.0.0.0` with explicit interface selection and an operator confirmation | — | **P0 (hard blocker)** |
| Realtime channel | MISSING | `ws` is a dependency; `WebSocketServer` used in `remote-test-gateway.mjs` and `pty-sessions.mjs` | Nothing for the canvas; transport is a 180 ms whole-document write | WebSocket broadcast of `object.*` events | host | **P2** |
| Two clients, one state | MISSING | — | — | Follows from the channel | realtime | **P2** |
| Works without internet | NEEDS EXTENSION | Persistence is fully local already | Only the LAN server is missing | Falls out of the host | host | **P2** |
| Internet publication | NEEDS EXTENSION | `funnelStartArgs`/`funnelStopArgs`, preflight, route-ownership check, rate limiter, generated secrets — all working | Bound to the remote-terminal gateway | Extract a publication module; never import the terminal gateway | host | **P7** |
| Space ID outlives host | MISSING | — | No resolution service | Small mapping service at the public domain | publication | **P8** |
| No visitor install (Tailscale/app/account) | READY by design | Visitors use a normal browser; the funnel is host-side only | — | Keep it that way | — | — |

## Identity, presence, control

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| Guest identity | MISSING | `cli/src/identity.rs`, HII Link contact card — both single-owner, signed | No anonymous session concept | Issue `guest_<random>` + signed per-space token | host | **P4** |
| No account to enter | MISSING | — | Nothing to remove; nothing to build on | Falls out of guest identity | guest | **P4** |
| Participant presence | MISSING | `cli/src/presence.rs` is operator continuity — unrelated | — | In-memory list, broadcast on the channel, never persisted | realtime | **P4** |
| Host: remove object | NEEDS EXTENSION | `deleteWorkspaceNodes` exists client-side | No host authority over a guest's object | Host-side operation gated by owner check | host, policy | **P6** |
| Host: remove participant | MISSING | — | — | Close socket + revoke token | guest, realtime | **P6** |
| Host: freeze writes | MISSING | — | — | Policy flag checked on the write path | policy | **P6** |
| Host: disable uploads / set limits | MISSING | — | — | Policy fields | policy | **P6** |
| Host: clear space | NEEDS EXTENSION | `workspace-store.ts` can write an empty doc | Not exposed | Host operation | host | **P6** |
| LOCAL vs PUBLIC definition | MISSING | — | — | Define "local" as *arrived over a LAN interface, not the tunnel*, and label it in the UI as exactly that — never as physical presence | host | **P9** |
| PUBLIC READ / LOCAL WRITE | MISSING | — | — | Policy evaluated per connection origin | policy, publication | **P9** |

## Persistence & safety

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| Survives host restart | READY (desktop) | Atomic write + revision to `~/.hii/workspace/workspaces/<id>.json`; assets on disk | The *host process* does not exist yet to be restarted | Reuse the store from the host | host | **P3** |
| Survives browser refresh | READY (desktop) / MISSING (web) | localStorage on the non-Tauri branch | Web state is per-browser | Host becomes the source; client holds no authority | host | **P3** |
| Blob durability on web | **MISSING** | `ingest.ts:245-247` POSTs to `/api/workspace/assets`, **which does not exist** (`output:'export'` forbids it; the handler is in `archive/`). Falls back to `URL.createObjectURL` with `ephemeral:true` | Every web image dies on refresh | Blob endpoint on the host | host | **P1** |
| Blob storage layout | NEEDS EXTENSION | `~/.hii/workspace/assets/` flat, via Tauri IPC, 250 MB cap, sanitized names | Not namespaced by space; not reachable over HTTP | `assets/<space_id>/`; HTTP endpoint | host | **P1** |
| MIME allowlist | MISSING | — | — | Allowlist + magic-byte sniff | blob endpoint | **P6** |
| File-size limit | NEEDS EXTENSION | 250 MB (owner-trusted) | Absurd for public upload | Per-space configurable, low default | blob endpoint | **P6** |
| Image dimension limit | MISSING | — | — | Decode-bomb guard | blob endpoint | **P6** |
| Rate limiting | NEEDS EXTENSION | `SlidingWindowLimiter` in `remote-test-gateway.mjs` | Not on the canvas path | Reuse the class | host | **P6** |
| EXIF stripping | MISSING | — | Phone photos carry GPS | Strip on ingest | blob endpoint | **P6** |
| Safe filenames | READY | `safe_asset_name()` sanitizes + truncates to 160 | Rust-side only | Port/mirror for the HTTP path | blob endpoint | **P6** |
| Content-Disposition / no executable content | MISSING | — | Uploaded HTML would be served as app content | `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + separate origin for blobs | blob endpoint | **P6** |
| Storage quota per space | MISSING | — | — | Counter on the Space record | Space record | **P6** |
| Report / moderation hook | MISSING | — | — | Minimal endpoint + host queue | host | **P6** |
| Save-conflict merge | NEEDS REFACTOR | `rebaseWorkspaceDoc` — correct, tested, **called by nothing** | No caller; `useWorkspace` swallows write errors | Call it from the host on revision conflict | host | **P3** |
| Two workspace-file implementations | NEEDS REFACTOR | Rust (`hii-core`, no lock) and TS (`workspace-store.ts`, locked) write the same files | Different guarantees for the same bytes | Host uses the TS one; Rust unchanged for the single-user path; document the boundary | — | **P3** |

## Product surface

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| QR generation | MISSING | no dependency, no generator | — | Encoder + canonical URL builder, surfaced immediately on create | Space record | **P5** |
| Create-Space flow | MISSING | `createWorkspace()` in `workspace-store.ts` | No UI, no Space record | `/new` | Space record | **P5** |
| `/s/:space_id` route | MISSING | — | Static export cannot serve it | Host serves it locally; Worker serves it publicly | host | **P1 (local)** / **P8 (public)** |
| `/spaces` page | MISSING | — | — | After the loop works | — | **P8** |
| "Create your own space" loop | MISSING | — | — | CTA on the visitor surface | P5 | **P8** |
| Accounts | MISSING | `lib/server/supabase.ts` unused by `app/` | — | Explicitly out of MVP | — | **P10** |
| Analytics | MISSING | — | — | Out of MVP | — | **P12** |
| Billing | MISSING | — | — | Out of MVP | — | **P13** |

## Repository health (blocks or endangers the above)

| Requirement | Current state | Existing code | Gap | Recommended action | Dependency | Priority |
|---|---|---|---|---|---|---|
| Deployable public site | **BLOCKED** | Live site is a SvelteKit build; `ls src` → absent; source is in `archive/legacy-svelte/`; `.svelte-kit` absent | The live site **cannot be changed from this repo** | Owner decision (arch §8). Recommend a separate Worker for `/spaces`, `/new`, `/s/:id` | — | **blocks P8 only** |
| Independent Spaces Worker preview | **WORKING** | `workers/spaces-public/`; workers.dev version `d07bd351-92b9-4b10-a022-587203256858` | Preview fixture is derived and read-only | Keep production resolver fail-closed until reviewed | Cloudflare Worker | **T13 preview complete** |
| Production Space resolver | **BLOCKED** | Typed, bounded resolver seam exists; production entry safely returns not found | No approved publication directory/replica binding yet | Implement provider-neutral resolver without making Cloudflare authoritative | resolver | **blocks production activation** |

| `wrangler.jsonc` | REMOVE/IGNORE (stale) | `main` and `assets.directory` → `.svelte-kit/cloudflare`, unbuildable | Points at nothing | Do not touch until the decision above | — | with P8 |
| `scripts/prepare-cloudflare-public.mjs` | REMOVE/IGNORE (stale) | cleans the same nonexistent dir | — | Same | — | with P8 |
| `ci.yml` job named "Svelte check" | REMOVE/IGNORE (cosmetic) | runs `tsc --noEmit` | Misleading | Rename | — | low |
| 26 quarantined test files | NEEDS REFACTOR | `vitest.config.ts` `svelteKitFossils`/`apiRouteFossils`/`packagingFossils` | Green suite covers 68 of 94 files | Honestly documented already. Rewrite or drop per file; **do not** add Spaces tests to any quarantine list | — | ongoing |
| `lib/landing.ts` | REMOVE/IGNORE | musician landing template, zero importers, references a `/landing` route that does not exist | Dead | Leave; do not extend | — | — |
| Duplicate canvas prototypes | REMOVE/IGNORE | `archive/…/prototypes/react-canvas/` mirrors `components/workspace/` | Confusion risk | Leave archived; never edit | — | — |
| Naming collisions | NEEDS REFACTOR | "space" = AeroSpace workspace; "presence" = operator continuity | Ambiguity in every future conversation | Adopt the vocabulary in arch §7; docs first, no symbol churn now | — | **P0 (docs)** |
| `aii/` migration debt | REMOVE/IGNORE for this project | ADR 004 names it | — | Out of scope | — | — |

---

## The critical path

Only these gaps stand between today and the §10 demo. Everything else is
polish or a later phase.

```text
1. Space record                      MISSING   -> P0
2. Server bound to a LAN interface   MISSING   -> P0   [hard blocker]
3. Blob endpoint on the host         MISSING   -> P1   [web images are ephemeral today]
4. Touch canvas (pinch/resize/delete/camera)  MISSING/PARTIAL -> P1
5. WebSocket object.* channel        MISSING   -> P2
6. Guest identity + presence         MISSING   -> P4
7. QR                                MISSING   -> P5
8. Host controls + upload safety     MISSING   -> P6   [required before any public pilot]
9. Funnel publication                EXTENSION -> P7   [code exists, needs extraction]
10. Public /s/:id resolution         MISSING   -> P8   [blocked on the website decision]
```

Item 2 is the single largest structural change: the repository has never had a
process that accepts a connection from another device.
