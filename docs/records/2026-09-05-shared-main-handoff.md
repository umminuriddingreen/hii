# Shared Main Handoff: Windows, Mac, Web

## Delivered Source

- Native HII Chat: shared Rust provider, structured message parts, message trees,
  SQLite checkpoints, Tauri streaming, and managed llama.cpp lifecycle.
- Account canvas selection and dirty-aware synchronization lifecycle fixes.
- Local Codex, Claude Code, and Pi JSONL session backups in HII SQLite, with
  immutable deduplicated snapshots and checksum-verified, no-overwrite restore.
- Guarded source update/check/rollback tooling and per-user scheduling.

The existing canvas remains the default. The website design is preserved.
These are extensions of HII, not a new application.

## Verified Before Integration

- Windows native llama.cpp stream, normal restart persistence, forced-crash
  partial-response recovery, and app-owned child-process cleanup passed.
- Canvas lifecycle: 34 frontend tests and 7 Rust account tests passed.
- Session backup: 9 shared core tests and CLI parse/routing test passed.
- Windows actual backup captured 340 source session files. One restore per
  provider passed both built-in and independent SHA-256 verification.

See `2026-09-05-windows-local-chat.md` and
`2026-09-05-personal-canvas-parity.md` in this directory for detailed scope.

## Remaining Verification and Boundaries

- `ummi` is the requested existing account. Mac CLI was not linked to an HII
  account when inspected; local identity `Ummi` is not proof of account login.
  Existing shared account architecture is cross-platform, but this user's
  complete three-device account/canvas round trip has not been demonstrated.
- Session snapshots are local, not uploaded to an account or another device.
  They preserve raw transcript data, which may be sensitive. Never commit the
  database, snapshot exports, credential files, or private session logs.
- Web build on Windows fails at `/opengraph-image` in Next's OG dependency after
  compilation/typecheck. No website deployment is claimed by this handoff.
- Six wider Windows CLI tests failed in paths/context/MCP/presence/atomic-write
  or Python portability areas. Targeted feature tests are not a full-suite pass.
- Mac has unfinished HII Drive changes. They must be preserved and reviewed by
  their owner before merging. A dirty checkout must block automatic updates.
- Account offline drafts/media sync and concurrent same-object conflict
  preservation still need dedicated acceptance coverage.

## Agent Procedure

1. Read `AGENTS.md`; inspect `git status --short --branch`.
2. Run `node scripts/hii-source-update.mjs status` for local source status.
3. When authorized to fetch, run `check`; use `update` only through its guards.
4. Read new commit summaries and this handoff before modifying shared modules.
5. Rebuild/test the affected host runtime. Source currency is not binary currency.
6. Record actual verification via `hii skill report`; do not upgrade unverified
   claims simply because a change reached main.

Source rollback never rewinds SQLite or session snapshots. Signed Tauri/UI
release publication and its signing credentials remain separate release work.

## Installed Source Maintenance

On 2026-09-05, `ef6aaf1` was pushed normally to GitHub main. Dedicated clean
checkouts were created at `C:\Users\ummin\dev\hii-main` and
`/Users/ummi/hii-shared-main`; both have 15-minute per-user source-update jobs.
Each job was invoked through its actual scheduler and completed with exit 0.
The Mac uses its existing GitHub SSH authentication; no credentials were copied.
All 12 source-update/scheduler tests passed on both operating systems.

Start new Codex or Claude sessions in these shared checkouts to read the current
AGENTS/CLAUDE handoff. An already-running session in a different checkout does
not automatically absorb new instructions. Keep active edits on a feature
branch or separate worktree: the scheduler blocks non-main and dirty checkouts.

The original Mac `/Users/ummi/hii` and older Windows checkouts are not silently
advanced. Their unfinished work remains with its current owner. Shared source
updates neither rebuild installed applications nor deploy the website.

Mac CLI build, nine session-backup tests, and actual capture of 1,187 session
files also passed from shared-main. No account upload is implied.

Both real clean checkouts subsequently updated from `ef6aaf1` to `b749042`,
rolled back to the recorded previous commit detached, and returned to main.
No database was restored or downgraded. The Mac's three-provider restore
verification and first scheduled backup both passed. Original Mac Drive dirty
paths were checked again and remain unchanged.
