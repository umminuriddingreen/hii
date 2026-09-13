# HII MCP

HII owns one canonical local MCP server:

```sh
hii mcp --authority workspace --client-identity <client>
```

It uses line-delimited JSON-RPC 2.0 over stdio. There is no second HII MCP
command or independently maintained canvas server.

Explicit browser capture has the same CLI/core ownership rule. The canonical
non-MCP ingest seam is `hii info ingest-web --input - --json`; see
[`save-to-hii-ingest.md`](save-to-hii-ingest.md). Browser adapters pass one
`hii.web.capture` payload to that command and do not write a parallel feed or
invoke publishing.

## Surface

`hii mcp` publishes the executable subset of HII's central tool manifest:

- Canvas: `canvas_list`, `canvas_read`, `canvas_add`, `canvas_update`
- HII context and information: `hii_context`, `info_find`, `info_capture`
- Work and operations: `og_next`, `caps_check`, `board_read`, `board_write`
- Skills and schedules: `skill_search`, `schedule_read`, `schedule_write`
- Systems and durable objects: `system_status`, `system_observe`, `object_list`, `object_read`
- Bridges: `bridge_read`, `bridge_send`
- Bounded workspace tools from the shared manifest, including read, list,
  search, HTTP, write, edit, shell, and verify when both the server authority
  and client ACL permit them.

Canvas writes use the canonical Runtime Space apply path, including optimistic
sequence checks, idempotency keys, an agent identity, an authority grant, and a
durable receipt. `canvas_add` accepts `note`, `canvas-text`, `image`, `link`,
`document`, or `frame`. `canvas_update` changes geometry or payload fields by
stable object ID.

## Client authority

The default role is read-only. HII's recommended `canvas-operator` role can
read the governed HII surface and mutate only canvas objects. It cannot call
shell, generic write/edit, board writes, schedules, or bridges. Canvas mutation
also requires a named client and workspace authority.

The local ACL is `~/.hii/mcp_acl.json` (or `$HII_MCP_CONFIG`). A minimal setup:

```json
{
  "clients": {
    "codex": { "role": "canvas-operator", "max_params_per_call": 64 },
    "pi": { "role": "canvas-operator", "max_params_per_call": 64 }
  },
  "defaults": { "role": "reader", "max_params_per_call": 64 }
}
```

## Codex

```sh
codex mcp add hii -- hii mcp --authority workspace --client-identity codex
```

The configured server name is `hii` and the executable command is always
`hii mcp`.

## Pi

HII maintains Pi's adapter at `integrations/pi/hii-mcp.ts`. Link it once:

```sh
ln -s /Users/ummi/hii/integrations/pi/hii-mcp.ts ~/.pi/agent/extensions/hii-mcp.ts
```

Pi discovers the live MCP catalog at startup and registers each tool with an
`hii_` prefix, such as `hii_canvas_add`. The adapter calls only `hii mcp`.

## Direct smoke test

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' |
  hii mcp --authority read-only --client-identity codex
```
