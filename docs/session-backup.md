# Local Agent Session Backups

HII stores immutable snapshots of Codex, Claude Code, and Pi JSONL sessions in
namespaced tables in its existing SQLite database. This is local recovery, not
account sync or an off-device backup. A failed disk can still lose both copies.

```sh
cargo build -p hii-cli
hii session-backup run
hii session-backup status
hii session-backup list
hii session-backup restore SNAPSHOT_ID NEW_FILE.jsonl
```

Use the just-built `target/debug/hii` (`hii.exe` on Windows) if PATH still points
to an older release or an SSH wrapper. Restore refuses an existing destination.
Status/list contain metadata, not transcript content. Raw restored data can
contain private project content or secrets and must not enter Git.

Sources are Codex `sessions` and `archived_sessions`, Claude `projects`, and Pi
`agent/sessions`. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`
override their respective defaults. Only JSONL is eligible; credential/config
files and linked/reparse paths are excluded. Inspect errors, missing sources,
and `linksSkipped` rather than assuming every discovered path was protected.

Changed files are captured as verified fixed-size prefixes, preserving valid
snapshots of growing sessions. Identical chunks are deduplicated. Unchanged
files use size/mtime to avoid rehashing. Restore verifies every chunk and the
complete snapshot. A per-database lock serializes backup scans.

## Scheduling

Windows: run `powershell -NoProfile -File scripts/hii-session-backup.ps1 -Install`
after building the CLI. The per-user task runs at login and every five minutes,
does not elevate, and refuses replacement of an existing task. Logs are local
metadata under `~/.hii/logs/session-backup.log`.

Mac: the one-shot `scripts/hii-session-backup-macos.sh` can be called by a
per-user LaunchAgent with `RunAtLoad=true` and `StartInterval=300`. Use absolute
paths to the checkout and log directory; build the CLI there first. Do not
overwrite an existing LaunchAgent. Scheduling does not rebuild the CLI.

## Verification Record

On Windows, 340 discovered sessions were backed up, with zero reported errors.
One snapshot from each provider was restored to a new local proof directory;
both core verification and independent SHA-256 comparison passed. A subsequent
scan skipped 338 unchanged files and captured two growing sessions. The Windows
scheduled task was also invoked successfully (LastTaskResult=0).

Shared core: nine tests cover deduplication, append/truncation, growth during
capture, timestamps, corrupt chunks, excluded paths, device namespaces, schema
coexistence, and backup writer locking. Mac execution is a separate verification
step, not implied by cross-platform Rust source.

Mac verification on 2026-09-05: CLI build and all nine core backup tests passed
from the clean shared-main checkout. The actual initial scan captured 1,187
files with zero errors, no missing source roots, and no skipped links. Use
`node scripts/hii-session-backup-verify.mjs` to restore the smallest snapshot per
provider and compare its SHA-256 independently. It creates new private proof
files; it never rewrites original sessions or existing restore destinations.

The Mac verifier passed for all three providers (453, 513, and 1,042 bytes).
Its `com.hii.session-backup` LaunchAgent was installed for the clean shared-main
checkout with a five-minute interval and successfully completed its first run
(exit 0). Both machines now have verified local scheduled backups. This still
does not provide account-bound or off-device backup.
