# AII Agent Workstation

A local-first desktop control plane for launching, monitoring, steering, and
recovering long-running AI coding agents across your own machines.

**One-liner:** Linear for AI coding agents running across a self-hosted compute fleet.

## Thesis

AI coding agents are becoming long-running distributed workers. They clone
repos, create git worktrees, install dependencies, run tests, open PRs, and
keep working for hours. That changes the shape of the workstation:

```
laptop            = control surface
Linux boxes       = execution substrate
tmux / Zellij     = persistence layer
git worktrees     = task isolation layer
GitHub PRs        = review / output layer
Tailscale + SSH   = access layer
KVM / Fingerbot   = recovery layer
AII Workstation   = the command center on top
```

This is **not** an IDE, not a chatbot, and not a model wrapper. It is the
dashboard between a human and their agent fleet.

## Current state — live on the HII backend

Everything the dashboard shows is real:

- **Projects & agent tasks** — read live (read-only) from the HII runtime
  database `~/.hii/hii.db`. Task metadata_json can carry agent-execution
  fields (`repo_path`, `branch`, `worktree`, `session`, `machine_id`,
  `agent_tool`, `pr_url`); missing fields fall back to AII conventions.
- **Machines** — the local machine with live `sysinfo` metrics
  (CPU/RAM/disk, refreshed every 5s) plus remotes from
  `~/.hii/remotes.json` (marked offline until the phase-4 SSH probe).
- **Embedded terminal** — bottom dock tab running a live local PTY
  (portable-pty + xterm.js). Phase 5 turns this into remote tmux/Zellij
  session attach.
- **Helium internal browser** — an embedded child webview pane (Tauri
  multiwebview) with a URL bar, for docs/PRs without leaving the
  workstation. Phase 8 routes "Open PR"/"Open Diff" here.

Not yet real: task create/stop/restart (phase 6–7), PR state (phase 8),
remote metrics and recovery (phase 4/9).

## Stack

- Tauri v2 (Rust backend, native shell)
- React 19 + TypeScript + Vite
- Tailwind CSS v4
- Later: SQLite (registry), SSH (execution), tmux/Zellij (sessions),
  GitHub CLI (PR loop), sysinfo (metrics), KVM/Fingerbot/WoL (recovery)

## Architecture

```
src/
  app/            views + settings screen
  components/
    layout/       AppShell (fixed control-plane grid), Sidebar, Topbar
    fleet/        machine cards, status dots, metric bars
    jobs/         job table, job detail, status badges
    projects/     project registry
    logs/         terminal-style log panel
    ui/           Button, Card, Badge, MetricBar primitives
  data/           typed mock data (machines, projects, agent tasks)
  lib/
    api.ts        ← THE data boundary. Mocked today; each function maps
                    1:1 to a Rust command and will become invoke() later.
    status.ts     status → color/label maps
    format.ts     time/percent formatting
  types/          Machine, Project, AgentTask, shared enums

src-tauri/src/
  models.rs       serde models mirroring src/types (camelCase)
  commands.rs     command placeholders with phase-tagged TODOs
  terminal.rs     real PTY session (portable-pty) streamed to xterm.js
  browser.rs      Helium child-webview navigation commands
  lib.rs          command registration
```

**The seam:** the frontend never touches mock data directly outside
`src/lib/api.ts`, and the Rust commands share its exact shape. Replacing
mocks with real infrastructure changes one file per layer.

## Conventions

- Session names: `aii__{project_slug}__{task_slug}`
- Branch names: `agent/{task_slug}`
- Worktrees: `~/aii/worktrees/{project_slug}/{task_slug}`

## Roadmap

| Phase | Goal |
| ----- | ---- |
| 1 ✅  | Mocked control plane UI |
| 2     | Local metrics via `sysinfo` |
| 3     | SQLite machine + project registry |
| 4     | Safe SSH test commands (`uname -a`, `tmux ls`, `gh --version`) |
| 5     | tmux/Zellij session lifecycle |
| 6     | Git worktree automation |
| 7     | Agent launch (Codex / Claude Code / custom) |
| 8     | GitHub PR tracking via `gh` |
| 9     | Recovery layer (KVM, Fingerbot, Wake-on-LAN, Tailscale status) |

North star: launch an agent task from the laptop, run it on a Linux machine,
watch its logs, see its branch/worktree, review the PR when it's done.

## Develop

```sh
npm install
npm run tauri dev    # full desktop app
npm run dev          # frontend only (browser, port 1420)
npm run build        # typecheck + bundle
```
