# Conversation archive and agent handoffs

HII keeps imported conversations in the local `~/.hii/hii.db` under `hii_imported_conversations`. Each record has a stable `chatgpt:<id>` or `codex:<id>` source ID, source path, content hash, message roles, and import time. Search is local FTS. Repeated sync updates changed conversations and skips unchanged Codex files. It imports user and assistant text; it excludes Codex tool calls, model reasoning, and ChatGPT system/hidden messages. The original export and session files remain untouched.

```sh
hii archive connect chatgpt /path/to/ChatGPT-export/conversations.json
hii archive connect codex ~/.codex/sessions
hii archive sync
hii archive status
hii archive search 'facade case study'
hii archive show chatgpt:<conversation-id>
hii archive install-sync
```

`install-sync` registers a user-level macOS LaunchAgent that repeats `archive sync` every five minutes. The source configuration is `~/.hii/imports/conversation-sources.json`, and the last result is `~/.hii/imports/last-sync.json`. Codex sessions change locally and can sync automatically. ChatGPT export data is a snapshot: to bring in later ChatGPT conversations, obtain a newer `conversations.json` export and connect it; HII does not claim access to an unexposed live ChatGPT history API. The archive stays on this machine unless the user separately exports or shares it.

## Central project workflow over MCP

The canonical `hii mcp` stdio server exposes the archive and bound projects as
one governed workflow. It uses the existing archive tables and operational
graph; it does not create another database or copy large project files.

| MCP tool | Purpose |
| --- | --- |
| `workflow_status` | List configured conversation sources, archive counts, sync state, and projects. |
| `workflow_source_connect` | Connect an explicit ChatGPT `conversations.json` or Codex sessions directory. |
| `workflow_sync` | Import or refresh every configured complete visible conversation. |
| `workflow_search` | Search archived chat text, project bindings, and project sources together. |
| `workflow_chat_read` | Return every imported user/assistant message for one archived chat. |
| `workflow_chat_link` | Link an archived chat into a project through the operational graph. |
| `workflow_project_read` | Return a project, all registered sources, and linked chats; `includeMessages` returns their complete imported messages. |

Read tools work under the default read-only MCP authority. Connecting,
syncing, and linking are mutations and require an operator/service ACL plus a
non-read-only authority envelope. Credentials, browser Cookies, model
reasoning, tool-call payloads, and hidden/system messages never enter the
central workflow.

```sh
hii mcp --authority personal-local --client-identity codex
```

The matching `~/.hii/mcp_acl.json` client should use the bounded
`workflow-operator` role. That role can call the three workflow mutations but
cannot write arbitrary files, run shell commands, or mutate the canvas. A
Codex installation can register the stdio server with:

```powershell
codex mcp add hii-workflow `
  --env HII_ROOT=C:\path\to\hii `
  -- C:\path\to\hii.exe mcp --authority personal-local --client-identity codex
```

The client discovers the tools through `tools/list`. For example, a
`workflow_chat_link` call uses:

```json
{
  "projectId": "<bound-project-id>",
  "conversationId": "codex:<archive-id>",
  "note": "Design-development record",
  "tags": ["architecture", "rhino"]
}
```

"Central" currently means one canonical local HII database and operational
graph. This MCP surface does not claim encrypted cross-device transcript sync;
that remains a separate HII device-trust and transport capability.

Agents coordinate through the local HII mailbox. A handoff records sender, recipient, task/thread, workspace, context references, an optional proof receipt, and a short message. Messages are immutable files in `~/.hii/agents/mailbox/messages`; acknowledgements are separate files, so no agent rewrites another agent's handoff.

```sh
hii agents send --from codex --to claude --task 'Windows release' --workspace ~/hii --context docs/records/2026-09-14-windows-review.md --receipt <run-id> --message 'Review the installed-app gap.'
hii agents inbox --for claude
hii agents ack <message-id> --as claude
hii agents thread 'Windows release'
```

`--to all` broadcasts to local agents. `hii agents guide` gives every configured agent the same handoff contract. Mailbox delivery is durable local coordination, not proof that a recipient process is running or has read the message. Cross-device delivery awaits a ready HII device executor; the enrolled Windows executor currently reports `pending-agent`.
