# HII Ecosystem Build Status

## CURRENT MILESTONE

CLI-owned local resource management and durable single-owner identity HTTP foundation.

## COMPLETED

- `hii ecosystem catalog --json` projects bounded, deterministic runtime references.
- Enrolled systems project as devices with `unknown` status; enrollment never implies liveness.
- Existing captures, workflows, and durable ecosystem events project only where their schemas are unambiguous.
- Captured URL credentials and query data are not projected.
- Packaged Tauri app invokes one fixed, bounded catalog command with generic errors.
- Ordinary browsers fail closed with an empty local catalog.
- Catalog resources can be searched and added or dragged onto the existing `HiiRoot` canvas as `hii-runtime` references.
- Durable owner-only identity ledger with locking, revision CAS, fsync, atomic rename, restart validation, and symlink rejection.
- Real `webauthn-rs` registration and authentication ceremony adapter.
- Loopback-only Axum listener with exact Host/Origin, double-submit CSRF, bounded requests, timeouts, concurrency limits, safe errors, and `Cache-Control: no-store`.
- Durable session logout clears cookies and rejects stale-session replay.
- Bootstrap and recovery remain explicit local stdin/terminal operations; no HTTP bootstrap, recovery, ledger, grant, device, or operator endpoints exist.
- No Supabase dependency or cloud-authoritative identity/resource store was introduced.

## IN PROGRESS

- None in this integration wave.

## BLOCKED

- Browser sign-in requires a local HII TLS surface and client ceremony wiring.
- Remote authenticated catalog access requires a reviewed TLS gateway/session binding.
- Windows identity-ledger storage requires owner-only ACL enforcement.
- Device readiness requires a live authenticated executor heartbeat.

## AGENTS ACTIVE

- None after integration validation.

## INTEGRATION STATUS

- CLI remains resource authority.
- Canvas remains a reference projection over canonical resources.
- Identity ledger remains local authority; HTTP is an adapter, not the store.
- Plaintext identity listener cannot bind outside loopback.
- Spaces, Workspace persistence, relay, production routes, and Supabase were not changed by this slice.

## TEST STATUS

- TypeScript check passed.
- Focused ecosystem adapter tests passed: 3 files, 15 tests.
- Full Vitest suite passed: 95 files, 592 tests.
- Next.js production build passed: 8 static pages.
- CLI catalog tests passed: 5 focused tests.
- Full CLI suite passed: 391 tests.
- Fresh CLI build and live `hii ecosystem catalog --json` passed.
- Tauri `cargo check` passed.
- Identity crate passed: 14 tests and Clippy with warnings denied.
- Identity crate formatting passed.
- Workspace-wide Rust formatting remains blocked by unrelated pre-existing formatting in `crates/hii-core/src/lib.rs`.
- Physical passkey, iPhone Safari, Windows ACL, and TLS-proxy tests remain unrun.

## KNOWN RISKS

- Real platform-authenticator completion is not yet proven.
- Registration permits are short-lived bearer secrets and must be redacted by a future TLS proxy.
- In-flight WebAuthn ceremonies intentionally do not survive restart.
- Normal loopback web mode cannot consume the CLI catalog; only the packaged Tauri bridge can today.
- Resource readiness remains unknown until live executor evidence exists.

## NEXT DEPENDENCIES

1. Add a local HII TLS surface and browser WebAuthn client wiring.
2. Bind an authenticated read-only catalog endpoint to minimal session state.
3. Add Windows owner-only ACL handling for the identity ledger.
4. Add authenticated node heartbeats before showing devices as online.
