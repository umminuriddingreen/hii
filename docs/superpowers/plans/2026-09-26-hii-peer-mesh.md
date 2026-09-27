# HII Peer and Bluetooth Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Foreground owns native installation, pairing, external actions, and multi-device proof.

**Goal:** Let HII users and delegated agents exchange scoped notes, document proposals, and task results through private networks and optional Bluetooth mesh.

**Architecture:** A HII-owned inbox/outbox and typed envelope sit above transport adapters. Reuse the private Rust TLS gateway for networks; adapt the cloned BitChat BLE/Noise engine into a managed Swift helper. Transport receipt does not grant execution authority.

**Tech Stack:** Existing HII Rust/Axum/SQLite networking; Swift/CoreBluetooth/CryptoKit/Noise components pinned to BitChat checkout `9b84b36`; existing native key storage and HII identity mapping.

**Spec:** `docs/superpowers/specs/2026-09-26-document-network-design.md`

## Global constraints

- Envelopes max 4 KiB serialized; body max 2 KiB; default expiry 24 hours.
- Native BLE target is macOS 13+/iOS 16+; no assumed Windows/Web Bluetooth support.
- Pair full fingerprints. Distinguish sender user, device, agent delegation, and permitted document scope.
- Public mesh channels do not carry private agent requests; Nostr/internet starts only by explicit opt-in.
- Bulk document snapshots, media, and models use an authorized LAN channel, not routine BLE messages.
- Inbox delivery, task acceptance, execution, and completion are distinct persisted states.

## Review focus

1. Duplicate/replayed deliveries must not duplicate jobs: Task 1.
2. Display-name spoofing or expired agent delegation must not establish authority: Task 1.
3. LAN disconnection must not lose or falsely acknowledge messages: Task 2.
4. Fragmented BLE messages, sleep, and restart must fail/report accurately: Task 3.
5. Two-device BLE tests must not be reported as mesh proof: Task 4.

### Task 1: HII envelope, inbox, and delegation

**Files:** create `crates/hii-core/src/messaging.rs`, `cli/src/message.rs`, `tests/unit/hii-peer-envelope.test.ts`; modify core exports and CLI command registration. Reuse document proposal/receipt contracts from the document-surface plan.

**Interfaces:** `PeerEnvelope {version,id,sender,recipient,type,correlationId,docRef,createdAt,expiresAt,body,contentHash,signature}`; `MessagingService.receive(envelope,verified_peer)`, `send(envelope,scope)`, `ack(id,state)`, `inbox(cursor)`. Agent delegation binds owner/device/agent, allowed docs/actions, and expiry.

- [ ] Add failing tests for a 4,097-byte envelope, 2,049-byte body, expired envelope, duplicate ID, invalid signature, renamed/spoofed peer, and revoked delegation.
- [ ] Implement schema checks, paired fingerprint identity binding, durable inbox/outbox, idempotent acknowledgment, and explicit acceptance before governed local execution.
- [ ] Add `hii message send/inbox` and scoped task acceptance. Test receipt identity and correlation ID persist across restart.
- [ ] Run focused Rust/core tests and commit this transport-independent slice.

### Task 2: Real private-network messaging and proposals

**Files:** modify `cli/src/network.rs`; create `cli/src/peer_transport.rs`, `lib/documents/peer-client.ts`, `components/workspace/documents/HiiShare.tsx`; test gateway authorization and reconnect scenarios.

**Interfaces:** transport implements `start`, `stop`, `peers`, `sendPrivate`, and inbound/delivery events. Gateway delegates inbox/document actions to the single HII runtime owner; it is not another document writer.

- [ ] Test an unpaired device, an unauthorized document reference, and a scope revoked during transfer are rejected.
- [ ] Implement paired LAN/Tailscale messaging through the existing private gateway and a small Share/People popover. Only selected peers/documents are offered.
- [ ] Prove request -> accepted bounded task -> proposal/result -> acknowledgment on two real HII devices; disconnect/reconnect mid-send and prove exactly-once task admission and preserved outbox state.
- [ ] Verify source excerpts are shared only within the agreed doc scope and only authorized artifact hashes resolve over the bounded network file channel.
- [ ] Record real-device evidence and commit/install the network slice.

### Task 3: Extract and prove the native BLE executor

**Files:** in the BitChat fork, create `localPackages/HiiMeshTransport/Package.swift` and its Transport facade, adapting `bitchat/Services/Transport.swift`, `Services/BLE/BLEService.swift`, fragment helpers, Noise service, and transport configuration; in HII create `adapters/mesh/macos/Package.swift`, `adapters/mesh/macos/Sources/HiiMeshHelper/main.swift`, `cli/src/mesh.rs`. Keep BitChat UI and Nostr runtime initialization outside the helper.

**Interfaces:** local IPC supports start/stop, peer snapshot/fingerprint, pairing decision, sendPrivateEnvelope, incoming envelope, and delivery state. HII Rust owns helper lifetime and authorizes operations; helper owns CoreBluetooth/Noise packet processing.

- [ ] Map/refactor the actual constructor dependencies (Keychain, Nostr identity bridge, scheduler, file store) into narrow injectable services. Do not claim a reusable library already exists.
- [ ] Test zero relay/network startup from BLE initialization; test unavailable Bluetooth, denied native permission, helper crash, and ephemeral identity fallback are reported explicitly.
- [ ] Implement a versioned HII text-envelope prefix over private BitChat messages and peer capability negotiation; unsupported clients remain messages, not agent execution peers.
- [ ] Build/sign/install the Mac helper with a clear usage description and the required Bluetooth entitlement. Pairing/permissions occur only as part of an explicit user test, not during planning.
- [ ] Prove two actual Apple devices communicate privately with Wi-Fi/internet disabled, including a fragmented 4 KiB envelope, deduplication, ACK, sleep/reconnect, restart, and a correlated scoped result. Record this as **BLE link proof**.
- [ ] Commit the fork extraction and HII adapter with bounded evidence. Preserve two-device link status until Task 4.

### Task 4: Mesh topology proof and optional internet rail

**Files:** add `scripts/hii-mesh-proof.mjs`, native transport tests, and a documented physical-device receipt. Optional Nostr adapter belongs in a later isolated task after explicit relay configuration is requested.

- [ ] Use three actual devices; prove endpoints cannot connect directly, then verify relay delivery through the middle device with message ID, TTL/hop observations, recipient ACK, and no duplicate task admission.
- [ ] Remove/sleep the relay and verify truthful queue/offline state; restore it and verify delivery within configured expiry.
- [ ] Measure payload overhead, latency, battery/activity, and reconnection on this topology. Report observed ranges rather than treating default TTL 7 as seven-hop coverage.
- [ ] Add the Nearby transport badge and mesh capability only after this evidence. Two devices do not pass this gate.
- [ ] If an internet rail is later authorized, isolate Nostr startup, private-envelope compatibility, explicit transmission scope, and relay proof. Do not promise generic NIP-17/44/59 interoperability.
- [ ] Record `hii skill report` receipts and publish only the source/artifacts explicitly authorized for release.

## Source pointers

- BitChat `Package.swift`: executable Apple target, not current transport library.
- `bitchat/Services/Transport.swift`: event delegate and transport interface.
- `bitchat/Services/BLE/BLEService.swift`: constructor coupling, CoreBluetooth, private typed-send boundary.
- `bitchat/Services/TransportConfig.swift`: default 469-byte fragments, nominal 512-byte maximum, TTL 7.
- `bitchat/Services/NoiseEncryptionService.swift`: Keychain identities and ephemeral fallback.
- `WHITEPAPER.md`: metadata, live/private vs offline-courier properties, and Nostr compatibility.
- HII `cli/src/network.rs`: existing private TLS/pairing gateway.

## Completion gate

Paired HII users and delegated agents exchange correlated, durable, authorized document proposals over a proven private network. BLE is labeled supported only on proven devices; mesh is labeled proven only with an observed third-device relay. No transport silently adds agent authority or cloud transmission.
