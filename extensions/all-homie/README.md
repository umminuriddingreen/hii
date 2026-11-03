# All Homie for HII

All Homie is the MCP entry point for agents working with HII. It uses the HII
CLI's existing model route, information search, agent directory, and mailbox; it
does not start a second daemon or create a separate agent registry.

## MCP tools

- `homie_answer` drafts a response with same-device loopback inference. It may
  use local HII information search for context. It returns an unsent draft and
  never posts or sends it.
- `homie_delegate` starts one bounded HII run in the active workspace. It uses
  the currently selected same-device model, allows at most 8 steps and 60
  seconds, defaults to read-only authority, and returns a receipt for review.
- `input_search` can discover active local agents with `sources: ["agents"]`.
  `agent_send` can hand work to an existing agent. A successful mailbox write
  means the handoff was recorded; it does not prove that the other agent is
  running or has read it.

The same operations are available from the CLI:

```sh
hii homie status
hii homie answer "Draft a reply to this request"
hii homie delegate "Inspect the workspace and summarize the failing check"
```

Register the existing HII MCP server with Codex on a device where `hii` is
installed and on `PATH`:

```sh
codex mcp add hii -- hii mcp --authority workspace --client-identity codex
```

This command is the same on macOS and Windows. Keep each device's client ACL and
MCP registration local to that device.

The CLI MCP server must be reachable by the agent host and the same-device
inference route must be configured on that host. All Homie rejects a remote
model endpoint. A workspace-authority delegate also requires the MCP server's
authority envelope to allow workspace writes.

## Portable static library

Each device selects its own mount path; no Mac path is copied to Windows.

```sh
hii storage status --json
hii storage set-root "/Volumes/HII Library"
hii storage path skills
hii storage path software
hii storage path tools
```

On Windows, pass the mounted directory using its Windows path, for example
`E:\\HII Library`. HII keeps model weights and the fast runtime under its local
runtime root. Skills install under the selected external `skills` area, and
executables placed in `tools/bin` are added to HII-managed process `PATH` after
the MCP/CLI process is restarted. The `software` area is a portable location for
static software bundles; OS package managers may still use their own install
locations.

Selecting a different root copies and byte-verifies existing static files,
switches the active path, then removes the moved source files. Conflicting target
files stop the move without deleting local files. HII keeps its skill lifecycle
ledger in the local runtime. Clearing the root moves static files back to local
storage. The external drive must be mounted and writable whenever its skills or
tools are needed. HII falls back to the historic local skill path when no
external root is configured.
