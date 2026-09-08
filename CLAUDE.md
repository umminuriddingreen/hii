# HII Shared Agent Entry

Read `AGENTS.md` and its required product context before changing this checkout.
Codex and Claude use the same source, verification receipts, and safety rules.

Start with `node scripts/hii-source-update.mjs status` and read
`docs/records/2026-09-05-shared-main-handoff.md`. Status is local-only; `check`
fetches remote main explicitly. Scheduled source updates never overwrite dirty
work. When blocked, report the changed paths and coordinate with their owner.

Do not treat a fetched source commit as a rebuilt or deployed application, or
local session backups as account-synchronized/off-device backups. Follow
`docs/hii-source-update.md` for source update and rollback procedures.
