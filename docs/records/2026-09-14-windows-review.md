# Windows HII work: evidence review

Date: 2026-09-14. This is a read-only review of the current Windows PC and the existing HII source; it does not claim a new Windows release.

| Layer | Finding | Evidence |
| --- | --- | --- |
| Source | The `ef6aaf11` integration added shared `hii-chat` Rust state, Tauri chat IPC, Canvas/Chat lifecycle, CLI chat verbs, backups, and a guarded source-update path. The Mac repository contains this commit. | `git show --stat ef6aaf11`; `docs/records/2026-09-05-windows-local-chat.md` |
| Focused native acceptance | A Windows debug executable completed a local llama.cpp text conversation, persisted streaming parts in SQLite, preserved Canvas on surface switching, restored after restart/crash, and cleaned up its owned process. The acceptance report records no errors. | `C:\Users\ummin\dev\hii-windows\artifacts\native-chat-acceptance-1788633115614\report.json`; five screenshots listed there |
| Installed app | HII 0.1.0 is registered and `C:\Users\ummin\AppData\Local\HII\hii.exe` exists. The file was last written 2026-09-03 22:03 UTC, before the September 5 chat integration. It is unsigned. The debug acceptance does not prove that the installed app has that change. | Windows uninstall registry, file metadata, `Get-AuthenticodeSignature` over read-only SSH |
| Device | `pc` is online on Tailscale, and SSH read-only inspection succeeded. HII's enrolled `windows-pc` executor still reports `pending-agent`; `hii on windows-pc apps list` requests agent installation/start. No `hii` process was running during the probe. | `tailscale status --json`; `hii systems status --json`; `hii on windows-pc apps list`; `Get-Process -Name hii` |
| Worktree | `C:\Users\ummin\dev\hii-windows` is on `codex/windows-local-chat` at `54c4bef` with modified and untracked artifacts. Preserve them. | `git status --short --branch`; `git log -8` over read-only SSH |

The main gap is release-layer proof. The source and isolated debug run support the Windows chat implementation, but the current installed executable predates it and the HII remote executor is not ready. Local chat is a text-conversation slice; its own design explicitly excludes tools and browser actions, so it should not be presented as the full HII agent loop. The existing Windows report also records a Next.js `/opengraph-image` build failure on that platform. A signed, current installer and a live installed-app acceptance run remain unverified.

The broad preservation audit script was attempted read-only over `hii-pc`, but its PowerShell stdin invocation produced no JSON payload. Direct read-only SSH queries supplied the observations above; the audit script itself remains unverified for this PC.
