# HII Ecosystem Architecture

## Product boundary

The private HII application is one canvas over the owner's devices, agents,
models, capabilities, jobs, files, services, Spaces, artifacts, and receipts.
It reuses `WorkspaceNode`, runtime object references, the operational graph,
grants, and receipts. It does not create a second canvas or cloud authority.

Supabase is not part of this architecture.

## Authority

- Mac, Windows, and an enrolled iPhone PWA are trusted writers for declarative
  canvas state.
- Each device persists signed operations locally and merges them
  deterministically after reconnecting.
- Files, terminals, models, GPUs, and other side effects remain owned by their
  named executor node.
- The owner-operated relay may store public device records, routing headers,
  acknowledgements, and opaque ciphertext. It cannot author HII operations or
  grant authority.
- Enrollment, revocation, recovery, and standing grants remain serialized HII
  security-ledger actions rather than CRDT state.

## Current implementation

```text
existing HiiRoot canvas
        |
        +-- authenticated ecosystem shell contract
        +-- reference-only resource projections
        +-- WorkspaceNode device/service/space kinds

WorkspaceReplica
        |
        +-- bounded signed-operation envelope
        +-- causal frontier and deduplication
        +-- deterministic field merge
        +-- preserved concurrent conflicts
        +-- permanent tombstones

hii-fabric-relay
        |
        +-- single-owner public device records
        +-- trust epochs and revocation checks
        +-- opaque ciphertext mailboxes
        +-- acknowledgement frontiers
        +-- bounded rendezvous signals
```

The current relay executable deliberately binds no network socket. Passkey
verification, TURN/DTLS, live node transport, remote terminal execution, and
production deployment are not implemented by these foundations.

## Required next layers

1. Durable IndexedDB and SQLite operation logs.
2. HII-owned passkey verification, recovery, and trusted-device key binding.
3. Authenticated signaling plus self-hosted STUN/TURN and WebRTC DataChannels.
4. CLI-owned Mac and Windows executor adapters.
5. Standing-grant job dispatch and encrypted raw-PTY transcript receipts.
6. Isolated preview for `app.humaninformationinterface.com` followed by
   physical Mac, Windows, and iPhone verification.

No DNS, route, or production deployment is authorized by this document.

## CLI-Owned Resource Catalog

The canonical local catalog is emitted by `hii ecosystem catalog --json`. It is a bounded, deterministic projection over the existing HII runtime: enrolled systems, browser captures, saved workflows, and durable ecosystem run/artifact/receipt events. It does not create another resource database and it does not infer liveness from enrollment.

The packaged Tauri application calls exactly one fixed `ecosystem_catalog` command. That command accepts no caller arguments, bounds execution time and output, and returns generic errors. Ordinary browsers receive no local catalog. Catalog entries retain `hii-runtime` object references when added to `HiiRoot`; the canvas is a projection, not authority.

## Durable Identity HTTP Boundary

`fabric/identity` owns the single-owner WebAuthn authority and durable trust ledger. The ledger store uses an owner-only file, an owner-only lock, revision compare-and-swap, bounded JSON, fsync, and atomic rename. Recovery, bootstrap, device authority, grants, and raw ledger state are not HTTP APIs.

The Axum adapter is local-only and rejects every non-loopback bind. It exposes health, CSRF, minimal session state, passkey registration/authentication ceremonies, and durable session logout. Mutation requests require exact Host, exact Origin, and double-submit CSRF. Responses are `no-store`. A future local TLS surface may proxy to this loopback listener; the plaintext adapter itself must never be exposed to a LAN or the public internet.
