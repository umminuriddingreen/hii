# Activation API contract (frozen 2026-07-18)

Single local-only endpoint backing the `/activate` wizard. This contract is
frozen for the founder-beta build: A1 (server) implements it, A2 (UI) consumes
it. Changes require editing this file first in the same commit.

## Endpoint

`POST /api/activation` — JSON body `{ "action": string, ...params }`.
Responses are JSON. Errors: HTTP 4xx/5xx with `{ "error": string }`.

Requests must originate from 127.0.0.1 (same guard pattern as the `/api/pty`
gateway in `server.mjs`). Never expose this route on a public host.

## Actions

### `detect`
Request: `{ "action": "detect" }`
Response: `{ "agents": [ { "id": "codex" | "claude" | "ollama", "installed": boolean, "authenticated": boolean | null, "version": string | null, "detail": string | null } ] }`
`authenticated` is `null` when it cannot be determined without a network call.
For `ollama`, `detail` lists locally available models when installed.

### `inventory` (preview before approval — creates no rows)
Request: `{ "action": "inventory", "rootPath": string, "exclusions": string[]? }`
Response: `{ "rootPath": string /* resolved real path */, "items": [ { "sourcePath": string, "kind": "markdown" | "text" | "code" | "config", "format": string, "sizeBytes": number, "freshnessAt": string } ], "count": number, "totalBytes": number }`
Server passes `approved: true` to `inventoryContextRoot` internally; the human
approval gate is the `create` action, which the UI only calls after the
explicit approve checkbox.

### `create` (approve + index)
Request: `{ "action": "create", "rootPath": string, "name": string?, "exclusions": string[]? }`
Response: `{ "project": ContextProject, "scan": ScanSummary }`
Calls `createContextProject({ rootPath, approved: true })` then
`scanContextProject(projectId, { exclusions })`. `ContextProject` and the scan
summary are the shapes exported by `lib/server/hii-context-dock.ts`.

### `state`
Request: `{ "action": "state", "projectId": string }`
Response: the `contextProjectState(projectId)` shape (`{ project, sources, lastScan, dbPath, localOnly }`).

### `sourceState`
Request: `{ "action": "sourceState", "sourceId": string, "pinned": boolean?, "excluded": boolean? }`
Response: `{ "ok": true }` (then UI refreshes via `state`).

### `start`
Request: `{ "action": "start", "projectId": string, "agent": "codex" | "claude", "task": string }`
Response: `{ "activationId": string, "startedAt": string, "runKind": "codex-exec" | "claude-spawn" }`
Server builds the orientation contract from `contextProjectState` + the task,
then routes: codex → daemon codex queue with `cwd` = project root; claude →
`agent.spawn` intent with new `cwd` field and `partner-onboard` preset.
Persists `~/.hii/activations/<activationId>.json`:
`{ id, projectId, agent, task, startedAt, status, receiptPath? }`.
`ollama` is not a `start` target in v1 (it backs codex/local profiles instead);
the UI shows it in `detect` results but routes execution through codex.

### `status`
Request: `{ "action": "status", "activationId": string }`
Response: `{ "status": "running" | "completed" | "failed" | "unknown", "receipt": Receipt | null }`
`completed` requires a receipt at `~/.hii/runs/cli/*/receipt.json` (via the
`latest` pointer) with mtime > `startedAt`; its parsed JSON is returned as
`Receipt` and its path recorded on the activation record.

## UI step mapping (A2)

1. choose agent → `detect`
2. folder path → (input only)
3. preview + excludes + approve checkbox → `inventory`, then `create` on approve
4. bounded task → (input only; 3 preset suggestions)
5. running → `start`, then poll `status` every 3s
6. receipt → render `Receipt` (summary, outcome, verification, checks, proof paths)
