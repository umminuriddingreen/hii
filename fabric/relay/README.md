# HII Fabric relay foundation

This standalone Rust crate defines the non-authoritative coordination boundary
for one owner's HII ecosystem. It is intentionally not part of the root Cargo
workspace yet and does not bind a socket, deploy a service, execute a job, or
grant authority.

## What it owns

- Bounded public account, device, passkey credential, and trust-epoch records.
- Per-device mailboxes containing only opaque authenticated ciphertext plus the
  routing headers needed to deliver it.
- Replay detection using envelope IDs and per-sender sequences.
- Compact identifier and sequence tombstones survive ciphertext acknowledgement
  or expiry so retained data can be deleted without reopening replay windows.
- Per-recipient acknowledgement frontiers and removal of acknowledged messages.
- Configurable message size, mailbox quota, retention, and signal bounds.
- Short-lived opaque rendezvous signals for future peer negotiation.
- A `RelayStore` persistence contract with deterministic in-memory and durable
  SQLite adapters.

## What it does not own

- HII objects, jobs, grants, receipts, files, Spaces, or Workspace state.
- Authentication decisions, passkey verification, enrollment approval, or
  recovery authority.
- Private device keys or any decryption key.
- Plaintext payloads, plaintext indexes, or content inspection.
- Transport security, TURN relay traffic, WebRTC, DTLS, or network listeners.

The existing HII runtime remains the authority. `record_revocation` only records
a trust-ledger mutation already authorized by that runtime; the relay cannot
originate one.

## Adapter boundaries

A production adapter must verify WebAuthn assertions with a maintained library
before invoking account or trust-record mutations. The shapes here contain only
credential identifiers, COSE public keys, counters, and public transport hints;
they are not a WebAuthn implementation.

Peer connectivity is also separate. A future gateway may carry these opaque
signals over authenticated HTTPS/WebSocket, then use WebRTC DataChannels with
DTLS and a self-hosted STUN/TURN service. This crate does not pretend to provide
those guarantees.

## SQLite adapter

`SqliteRelayStore::open` creates or opens a standalone SQLite database and
applies its schema transactionally. Account/device/passkey records are public
metadata. Mailbox and rendezvous bodies are opaque `BLOB` values; there are no
plaintext payload or content indexes. Acknowledgement, expiry, and signal
consumption remove deliverable ciphertext while retaining compact replay
tombstones.

Mailbox reads durably mark the returned envelopes as delivered. An
acknowledgement is rejected unless its sequence identifies delivered ciphertext;
it cannot skip over and delete an unseen live envelope. Retrieval is scoped to
the caller's already-validated current trust epoch, so recovery or revocation
does not expose stale-epoch messages. Rendezvous batches are read and consumed
in one SQLite transaction.

On Unix, a newly created database file is set to owner read/write (`0600`). The
operator must also place it in an owner-only directory (`0700`), because SQLite
may create journal files beside it and directory permissions govern those
files. Existing file permissions are never widened. On Windows, use an
owner-only directory protected by the account ACL. Database encryption is not
provided: the database contains public metadata and opaque ciphertext only.

This store is not an authentication boundary. Any future HTTP, WebSocket, or
other network adapter must authenticate the caller, bind it to an active device
record and current trust epoch, enforce request bounds, and fail closed before
calling `Relay`. The crate intentionally has no listener and must not be exposed
directly.

## Local checks

```sh
cargo run --manifest-path fabric/relay/Cargo.toml
cargo fmt --manifest-path fabric/relay/Cargo.toml --check
cargo test --manifest-path fabric/relay/Cargo.toml
cargo clippy --manifest-path fabric/relay/Cargo.toml --all-targets -- -D warnings
```
