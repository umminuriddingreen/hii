# HII Fabric identity foundation

This standalone Rust crate owns the single-owner authentication and
trusted-device authority boundary that the transport-independent protocol and
non-authoritative relay intentionally leave open.

## What it owns

- Passkey registration and authentication ceremonies through maintained
  `webauthn-rs`, configured for one exact RP ID and HTTPS origin.
- Bounded, expiring, server-side ceremony state that is consumed once.
- Public passkey records. WebAuthn and device private keys are never accepted or
  stored.
- Device enrollment proposals bound to SHA-256 fingerprints of separate
  signing and encryption public keys.
- A serialized, monotonic trust ledger for devices, sessions, scoped standing
  capability grants, revocations, and trust epochs.
- One-time recovery codes stored only as Argon2id PHC hashes. Recovery rotates
  the trust epoch and revokes every prior device, passkey, session, and standing
  grant.
- One-time high-entropy bootstrap/recovery permits for registering the first
  passkey in a trust epoch; only their SHA-256 hashes enter the ledger.

## Boundaries

This is not an HTTP server, database, network listener, token service, CLI
integration, or cryptographic transport. `AuthenticationSession` values can be
created only after `webauthn-rs` verifies a browser assertion. Adapters must
store the serialized `TrustLedger` durably and atomically after every successful
mutation, keep the in-progress `IdentityAuthority` process-private, set secure
cookies or transport bindings themselves, and never expose bootstrap-only
passkey registration over an untrusted network.

The enrollment approval API rechecks the fingerprints shown to the owner, so a
proposal cannot silently substitute different public keys. A session and every
grant are pinned to the current trust epoch. IP addresses, hostnames, URLs, and
transport claims are never identity proof.

The crate tests challenge creation, bounded/expiring state, recovery one-time
use, enrollment binding, revocation, epoch rotation, and capability scope. A
full WebAuthn assertion is not synthesized: browser/virtual-authenticator
integration belongs to the future HTTP adapter. Until `finish_authentication`
receives a genuine verified assertion, no public API returns an authenticated
session.

## Local proof

```sh
cargo fmt --manifest-path fabric/identity/Cargo.toml --check
cargo test --manifest-path fabric/identity/Cargo.toml
cargo clippy --manifest-path fabric/identity/Cargo.toml --all-targets -- -D warnings
```
