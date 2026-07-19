# Codex app-server integration

HII builds on Codex through its supported `app-server` protocol. The fork at
`/Users/ummi/codex` is reserved for narrow, reviewable changes that cannot be
implemented through the public protocol. HII remains the control plane and
owns task bounds, approvals, logs, proof, verification, and receipts.

## Current proof

```sh
hii codex app-server-probe
```

The probe launches the configured Codex binary over stdio JSONL, identifies
itself as `hii_cli`, completes the required initialize handshake, prints the
server metadata, and exits without starting a thread or model turn.

HII also owns a persistent local app-server lifecycle:

```sh
hii codex app-server start
hii codex app-server status
hii codex app-server logs
hii codex app-server stop
```

It listens on `~/.hii/codex/app-server/app-server.sock`. The Unix socket is
local-only; HII records its PID, status, and logs beside it.

Pin the contract exposed by the currently configured Codex binary with:

```sh
hii codex schema pin
```

This stores the bundled v2 JSON Schema and a SHA-256 manifest under
`aii/codex/schema/<codex-version>/`.

Read threads without starting or mutating a session:

```sh
hii codex threads --limit 10
hii codex threads --cwd /Users/ummi/hii --json
```

The client connects through the private Unix socket, completes the app-server
handshake, and calls `thread/list` with `useStateDbOnly: true`. HII writes a
metadata-only read receipt to `~/.hii/codex/app-server/reads.jsonl`; names and
previews are displayed locally but are not copied into the durable receipt.
Notification method names and counts are retained as protocol evidence; their
payloads are not duplicated.

## Integration order

1. Map live thread, turn, item, approval, and token notifications into HII run
   events.
2. Present approvals and live proof in HII before enabling mutations.
3. Patch the fork only where the public protocol cannot express a required
   HII contract; keep `upstream` mergeable and changes isolated.

Do not copy Codex credentials, private prompts, or raw reasoning into HII
receipts. Store references, redacted events, artifacts, and verification data.
