# HII Update: agent-managed, user-curated

HII coordinates the user's software, projects, creative tools, and own network.
It does not replace the operating system. The user states a desired capability;
an agent can build it in source, run checks, and leave a reviewable branch and
receipt. The user curates direction and result rather than manually wiring each
tool together.

`hii update status` reports the configured source checkout when present, dirty
state, feature-run records, and the last Codex knowledge sync. Set
`HII_SOURCE_CHECKOUT` when the source is not `~/hii`.

`hii update feature "<request>"` requires a HII source checkout. It creates a
new branch from that checkout's committed HEAD and an isolated worktree under
`~/.hii/update/runs/<id>/source`, then starts a Codex Luna build there. Existing
dirty worktrees remain untouched; their uncommitted files are not silently
copied into the new branch. The run's JSONL events, final response, and exit
receipt stay next to its source. A created branch is source work, not an
installed app update.

`hii update sync` reads local Codex personal skills and memory files, detects
changes by content hash, and saves changed files through HII's local file-memory
contract. It keeps source paths and immutable versions under `~/.hii`; it does
not upload them to an account or another device. The desktop reconciles while
open. On macOS, `node scripts/hii-codex-sync-schedule.mjs install` adds a
per-user 15-minute LaunchAgent invoking the installed CLI, so reconciliation
continues when the app is closed. `status` reports the installed and loaded job
state; an existing plist or loaded job is never overwritten.

The desktop's **Build a HII feature** action calls the same native CLI command.
The **Update HII** notice shows local source and Codex sync state alongside the
existing signed app update. A source branch must be reviewed, integrated,
built, and installed through the release path before it changes the app. Web
changes still require live deployment and route verification.
