# Personal Canvas Parity

## Requested Outcome

Use the existing personal Mac identity/account as the starting point for one
persistent HII canvas across Mac, Windows, and web. Do not create a replacement
identity or overwrite local canvas content to make a sync demo pass.

## Verified Starting Point

- Mac source `/Users/ummi/hii` is at committed `463c854d`, with unrelated local
  HII Drive changes. Windows integration remains in `dev/hii-windows` on the
  matching committed base plus the previous local-chat work.
- Mac `hii login status` reports local identity `Ummi` and HII account not
  connected. This does not prove the user lacks a registered website account.
- Mac workspace JSON files and `hii.db` exist. A read-only SQLite inspection
  could not open that database; its contents were not inspected or migrated.
- Website account session endpoint responds HTTP 200. The unauthenticated probe
  was not a login or verification of the user's account.
- Current website account authentication is passkey-based. No password-based
  sign-in or password enrollment was added. Local identity is not proof of
  registered account ownership.

## Changes In This Worktree

- `components/desktop/DesktopHiiAccess.tsx` and CSS expose account and workspace
  controls, restore the selected account canvas, keep explicit local selection,
  block switching/linking while changes are unsaved, and do not open a blank
  editable fallback when account loading fails.
- `lib/desktop/account-selection.ts` implements the typed preference boundary
  and deterministic selection resolution. No document is imported by selection.
- `src-tauri/src/account_sync.rs` stores device-scoped workspace preferences in
  the existing SQLite database. `src-tauri/src/lib.rs` registers the commands;
  `src-tauri/Cargo.toml` declares the existing SQLite dependency directly.
- CLI and desktop credential paths now both honor `HII_ACCOUNT_DIR`, otherwise
  using the HII runtime's `account` directory. No credential was copied.
- `components/workspace/useWorkspace.ts` guards async workspace lifecycles,
  retains dirty edits during remote updates, exposes load/save errors and retry,
  and warns before closing with unsaved changes.
- Account persistence adapters retain revision bases for conflict handling and
  coordinate polling with writes. Web account canvases remount by account and
  workspace identity; unsaved changes guard navigation and sign-out.
- `components/workspace/HiiRoot.tsx` and scoped global styles show load/save
  status and retry controls for the shared canvas surface.
- Focused tests cover selection, UI access, persistence lifecycle, and adapters.

## Verification

- `npm run check`: passed.
- Focused frontend suite: 34 tests passed across desktop account access,
  selection, workspace lifecycle, account adapters, and merge behavior.
- `cargo test -p hii-cli account::tests`: 3 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib account_sync::tests`:
  4 passed, including SQLite restart, isolation, and preservation tests.
- Desktop Next static export: passed.
- Windows native executable rebuild with `tauri/custom-protocol`: passed.
  New account behavior has not yet been exercised in the native GUI.
- `npm run build`: compilation/typechecking passed, web export failed at the
  existing Windows `next/og` Invalid URL issue in `/opengraph-image`. No partial
  output was deployed to production.
- `git diff --check`: passed.

## Not Yet Proven

This is preparatory repair, not a completed three-platform account-sync rollout.
No Mac source files or canvas documents were replaced. No real canvas was
uploaded, no registered identity was replaced, and no password was requested.
The changed source has not been deployed to the website or installed on Mac.

Account workspace documents remain server-durable while connected, but local
offline cache/outbox durability is still missing. Imported media bytes remain
device-local. Same-node edit conflicts still use the existing timestamp-based
merge policy, not lossless collaborative text editing. Browser unload warnings
are not a crash-safe draft store.

## Next Acceptance Gate

1. Identify the user's existing registered account through their own Mac browser
   sign-in, without asking them to send a password or copying session tokens.
2. Link Windows as its own revocable device, not by copying the Mac credential.
3. Inventory the intended local canvas and account workspaces. If import is
   needed, preserve a local backup and preview the exact content before upload.
4. Verify notes, positions, links, ink, deletion, concurrent edits, and restart
   across the same account workspace on native Mac, native Windows, and web.
5. Implement offline draft durability and private media transfer before claiming
   all canvas content works reliably across devices.
6. Add authenticated password enrollment to the existing registered account only
   after ownership is proven. Preserve existing passkeys and account IDs; never
   accept a local display name as authorization to set a registered password.
