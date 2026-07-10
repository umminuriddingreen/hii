# AII / HII Boundary Contract

*Established 2026-07-10. This is the source of truth for what belongs in which layer.*

## The two layers

**HII — the interface layer (`~/hii`)**
Everything concerned with *surfaces* and how humans and agents use them:
- The canvas homepage, boards, feed, dashboard, terminal UI, Tauri shell
- The web server (`server.mjs`), PTY gateway, and all `app/api` routes
- The *presentation* of state: rendering jobs, capabilities, agents — not deciding them
- An **agent-facing surface contract**: every UI affordance HII offers must also be reachable as a declared capability (JSON schema + endpoint), so agents use HII the same way humans do

**AII — the agent coordination & capability layer (`~/dev/aii-workstation` → canonical agent runtime)**
Everything concerned with *agents as workers*:
- Agent lifecycle: spawn, monitor, steer, recover (currently `hiid.mjs`, spawn routes, bridge)
- The capability registry and policy engine (currently `lib/capabilities`, `~/.hii/capabilities.json`, skills registry)
- Inter-agent messaging (bridge), job/run records, machine fleet
- **Configuration authority over HII**: AII may write HII's config (layouts, defaults, enabled surfaces) to fit the user; HII reads config, never the reverse

## Dependency rule

```
AII  ──writes──▶  config / runtime state (~/.hii)  ◀──reads── HII
AII  ──calls──▶  HII capability endpoints (declared surface API)
HII  never imports AII logic; it renders AII state and exposes surfaces
```

`~/.hii` is the shared runtime substrate both sides meet at: AII writes
`config.json`, `capabilities.json`, daemon/job state; HII reads them and
renders. HII writes only *user-intent* events (clicks, board edits), which
AII consumes.

## What moves where (migration targets)

| Today (in ~/hii) | Belongs to | Action |
|---|---|---|
| `scripts/hiid.mjs` (daemon supervisor) | AII | move to AII, keep `~/.hii/daemon` file contract |
| `lib/capabilities`, `lib/admin-agent` | AII | extract; HII keeps a thin read/render client |
| `bridge/`, bridge skills | AII | move; HII gets a bridge *viewer* surface |
| agent spawn in `lib/server/hii-terminal.ts` | AII | HII surface posts intent; AII daemon executes |
| `app/api/*` UI-serving routes, canvas, boards | HII | stays |
| PTY gateway/sessions | HII | stays (it is a surface); AII attaches to sessions via the same WS contract |
| skills registry `~/.hii/skills` | AII-owned data | HII renders it |

## End state

AII observes how the user works (jobs, boards, attention data) and
*reconfigures HII* — surfacing the right canvas objects, terminals, and
capabilities for the user's current goals. HII stays a beautiful, dumb-ish,
capability-declaring surface.
