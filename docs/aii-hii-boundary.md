# AII / HII Boundary Contract

*Established 2026-07-10. This is the source of truth for what belongs in which layer.*

## The two layers

**HII — the interface layer (`~/hii`)**
Everything concerned with *surfaces* and how humans and agents use them:
- The HII spatial homepage, boards, feed, dashboard, terminal UI, Tauri shell
- The web server (`server.mjs`), PTY gateway, and all `app/api` routes
- The *presentation* of state: rendering jobs, capabilities, agents — not deciding them
- An **agent-facing surface contract**: every UI affordance HII offers must also be reachable as a declared capability (JSON schema + endpoint), so agents use HII the same way humans do

**AII — the agent coordination & capability layer (`~/hii/aii/` — lives inside the HII repo)**
Everything concerned with *agents as workers*:
- Agent lifecycle: spawn, monitor, steer, recover (currently `hiid.mjs`, spawn routes, bridge)
- The capability registry and policy engine (source in `aii/capabilities`, published to `~/.hii/capabilities.json`, with the skill-growth registry under `~/.hii/skills`)
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

AII lives in the same repo (`~/hii/aii/`) but the boundary is enforced by the
dependency rule: nothing under `app/`, `lib/`, `components/` imports from
`aii/` — HII reaches AII only through `~/.hii` state files and process
execution (spawning `aii/daemon/hiid.mjs`). Current layout:
`aii/daemon/hiid.mjs` (runtime supervisor, moved 2026-07-10) and
`aii/workstation/` (the Tauri control plane, moved from `~/dev/aii-workstation`
with a compatibility symlink left behind; its pre-move git history is archived
at `~/.hii/archive/aii-workstation-git-2026-07-10`).

| Today (in ~/hii) | Belongs to | Action |
|---|---|---|
| `scripts/hiid.mjs` (daemon supervisor) | AII | ✅ moved to `aii/daemon/hiid.mjs` (2026-07-10), `~/.hii/daemon` file contract unchanged |
| `lib/capabilities`, `lib/admin-agent` | AII | ✅ (2026-07-10) registry/packs data → `aii/capabilities/`, admin-agent logic → `aii/admin-agent/`; hiid publishes the registry to `~/.hii/capabilities.json` and HII's thin client (`lib/capabilities/index.ts`) reads the published copy |
| `bridge/`, bridge skills | AII | ✅ (2026-07-10) message drop moved off the repo to the runtime substrate `~/.hii/bridge/messages` (`hii bridge` CLI updated; skills unchanged — they call the CLI); HII bridge *viewer* surface still to build |
| agent spawn in `lib/server/hii-terminal.ts` | AII | ✅ (2026-07-10) HII appends `agent.spawn` intents to `~/.hii/daemon/intents.jsonl` and records a `queued` job; hiid consumes intents (cursor at `intents.cursor.json`, history skipped on first run), runs the claude CLI, and appends the `running`/`failed` job update under the same id |
| `app/api/*` UI-serving routes, workspace, boards | HII | stays |
| PTY gateway/sessions | HII | stays (it is a surface); AII attaches to sessions via the same WS contract |
| skills registry `~/.hii/skills` | AII-owned data | HII renders it |

## Configuration authority (live since 2026-07-12)

AII owns `~/.hii/config.json` (surface enablement + defaults + agentNotes).
hiid seeds it on start and mutates it via `hiid config set <dot.path> <value>`
(every change is an auditable `config.updated` event). HII reads it through
`lib/server/hii-config.ts` (`readHiiConfig` / `surfaceEnabled`) and serves it
read-only at `/api/config` (capability `hii.config.read`). HII never writes
this file. The pre-existing legacy engine config that lived at that path is
archived at `~/.hii/archive/config.json.legacy-engine-2026-07-12`.

## End state

AII observes how the user works (jobs, boards, attention data) and
*reconfigures HII* — surfacing the right workspace objects, terminals, and
capabilities for the user's current goals. HII stays a beautiful, dumb-ish,
capability-declaring surface.
