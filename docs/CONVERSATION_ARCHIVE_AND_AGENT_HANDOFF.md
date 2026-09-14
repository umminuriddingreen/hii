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

Agents coordinate through the local HII mailbox. A handoff records sender, recipient, task/thread, workspace, context references, an optional proof receipt, and a short message. Messages are immutable files in `~/.hii/agents/mailbox/messages`; acknowledgements are separate files, so no agent rewrites another agent's handoff.

```sh
hii agents send --from codex --to claude --task 'Windows release' --workspace ~/hii --context docs/records/2026-09-14-windows-review.md --receipt <run-id> --message 'Review the installed-app gap.'
hii agents inbox --for claude
hii agents ack <message-id> --as claude
hii agents thread 'Windows release'
```

`--to all` broadcasts to local agents. `hii agents guide` gives every configured agent the same handoff contract. Mailbox delivery is durable local coordination, not proof that a recipient process is running or has read the message. Cross-device delivery awaits a ready HII device executor; the enrolled Windows executor currently reports `pending-agent`.
