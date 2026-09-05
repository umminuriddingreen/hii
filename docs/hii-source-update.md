# HII Source Updates and Agent Handoff

Source updates, installed CLI releases, signed desktop updates, and UI bundles
are separate operations. Pushing main does not update an installed application.

## Source Checkout

Run from a trusted current checkout, or pass its absolute script path:

```sh
node scripts/hii-source-update.mjs status --repo /path/to/hii
node scripts/hii-source-update.mjs check --repo /path/to/hii
node scripts/hii-source-update.mjs update --repo /path/to/hii
node scripts/hii-source-update.mjs rollback --repo /path/to/hii
```

`status` reads cached local git state without contacting any server. `check` and
`update` explicitly fetch only origin main, without tags. Output is JSON with
current and remote commit IDs, branch, dirty, ahead/behind counts, blocked reason,
and rollback availability. A failed/blocked update never stashes, resets, cleans,
commits, or discards tracked or untracked work. Update requires clean main and a
fast-forward history. Divergence requires human reconciliation.

Successful updates record previous/applied commit refs under
`refs/hii/source-update/`. These git refs are the durable rollback authority and
keep both commits reachable. The `.git/hii-update-status.json` file is only a
machine-readable advisory cache. Linked worktrees use their own git directory
for the cache and a shared git-directory lock for updates. A stale lock after a
crash is reported, not automatically removed; verify no updater is active before
removing only that lock file.

Rollback requires a clean checkout still at the recorded applied commit. It
switches to the previous commit **detached**, preserving the main branch and all
data. It is not a database migration rollback. After inspection, `git switch
main` returns to the applied source. Do not create new work while detached
without first creating a branch.

Automatic scheduling is deliberately not installed by this script. An approved
per-user scheduler may invoke `check` to report updates, or `update` for an
explicitly designated clean checkout. It must not target an actively edited
Mac/Windows worktree. Dirty work is a stop condition, including the Mac's local
HII Drive changes. No signed release, build, deployment, or app restart is
performed by source update.

Install a 15-minute per-user schedule in a dedicated clean checkout:

```sh
node scripts/hii-source-update-schedule.mjs install --repo /path/to/clean/hii
node scripts/hii-source-update-schedule.mjs status --repo /path/to/clean/hii
```

Use `--dry-run` to inspect the plan without installing. Existing jobs are never
replaced. Windows uses a hidden, non-elevated Task Scheduler job; Mac uses a
per-user LaunchAgent. Execution logs contain timestamps and exit codes only in
`~/.hii/logs/source-update.jsonl`. This does not install or update Node itself.
After a source rollback, the detached checkout blocks further automatic updates
until the operator switches back to main. The first tracked update after
installation creates the rollback anchor; installation alone creates no anchor.

## Codex and Claude Handoff

After updating source, read `AGENTS.md`, the required product/decision documents,
and `docs/records/2026-09-05-windows-local-chat.md` plus
`docs/records/2026-09-05-personal-canvas-parity.md`. Use `hii agents guide` for the
shared agent contract. A currently running agent does not automatically reread
instructions when git changes; explicitly send the new commit and these paths
to the session, or start a new session in the updated checkout. Do not overwrite
private global Codex/Claude instruction files or credentials.

Windows integration adds native local Chat while preserving Canvas. Account
canvas and private local chat are separate persistence domains. Mac HII Drive
work must be preserved and reviewed separately, not silently replaced. Read the
records for actual verification and remaining platform/authentication gaps.

## Existing Release Mechanisms

- `scripts/hii-release-installer.mjs`: builds/copies a versioned local CLI release,
  smoke-checks it, switches a launcher marker, records the old marker, and attempts
  transaction rollback on install failure. This is not the source updater.
- `lib/client/hii-updates.ts`: Tauri signed binary update/install/relaunch. A
  source change adding Rust commands requires a rebuilt native release.
- `src-tauri/src/ui_channel.rs`: signed UI-only bundles, polling, staging, and
  explicit selection of older installed versions. UI bundles cannot add Rust
  commands. Existing auto-apply reloads without a dirty-draft handshake or
  application-health rollback, so do not enable it for active unsaved sessions.

## Validation

```sh
node --test scripts/hii-source-update.test.mjs
```

Tests use temporary local bare remotes only: cached status, explicit fetch,
fast-forward, detached rollback, dirty/untracked preservation, branch/divergence
refusal, and changed-HEAD rollback refusal. They do not publish or alter real
remotes, user files, account data, or installed apps.
