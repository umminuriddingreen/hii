# Private personal workspace

The signed-in owner homepage and `/personal/` are the plain chat projection of HII's CLI-owned local agent workspace.
Only the account ID in `HII_PERSONAL_ACCOUNT_ID` can load the page, assets, access
endpoint or viewer socket. The account handle is not trusted as authorization.
The public HII canvas offers its owner a Personal chat link after a server check.

The Mac bridge opens an outbound authenticated WebSocket. It forwards a closed
set of application routes to loopback port 4188; it cannot proxy arbitrary URLs,
ports or files. The PC remains a model route behind the existing local server.
No conversation bodies are persisted by the relay. Session validity is checked
for every request/upload frame. Browser request cancellation and disconnection
abort corresponding local fetches. The bridge reconnects automatically.

The application still owns the backend's existing authority: `/run` executes HII
within its configured workspace. Protect the bridge configuration as a secret.
A disabled/missing owner secret denies all viewers. Rotating the host key
requires restarting the bridge. Mac sleep or loss of connectivity makes the
backend unavailable; the UI reports this instead of routing inference elsewhere.

## Shared interaction model

Text and slash commands are two input forms for the same HII capabilities.
The embedded mini-canvas editor is removed. Each message has a stable ID and a
WorkspaceNode-compatible text projection. Attachments and generated images are
asset nodes, deduplicated by source identity. Streaming updates the existing
response node. These projections are saved in each chat's `objects` in the
existing CLI workspace, preserving placement. They are the basis for a future
2D view; this change does not yet render them in the main HII canvas.

## Verification

- `node --test personal-workspace/*.test.mjs`
- `npm run check`
- `npm run worker:check`
- `personal-workspace/relay-smoke.mjs` checks local fixture accounts and the real
  local backend through a local Worker on 4199 (requires fixture setup).
- `npm run deploy` builds the site and Worker.

Private assets are generated from `personal-workspace/public` by prebuild.
No private user data or credentials belong in this directory.

## Canonical app

Run `npm run personal:start` from the HII checkout. The loopback service and its
agent adapter live here; chats remain in the same CLI-owned workspace storage.
The desktop linked to `ummi` opens this service inside its main window. Canvas
remains reachable from the chat view. The website serves the same interface at
`/` for the authorized owner; `/?view=canvas` opens the spatial workspace.

## Continuous messages

Send stays available while an agent turn runs. Follow-ups enter the existing
agent-chat queue and run in acceptance order; they do not interrupt a running
tool. Stop cancels the selected chat's active and queued turns. Other chats keep
their own drafts, responses, and cancellation state.

The same behavior is available through `hii agents chat send CHAT_ID TASK`.
Accepted turn IDs, text, and status are recorded locally under
`~/.hii/agents/chat-loops`. Reopening the page reconciles recorded answers.
Disconnect and service restart do not automatically replay work: interrupted
turns remain inspectable through `hii agents chat show CHAT_ID`.

The executor processes one turn at a time, with at most 16 pending turns per
chat. Existing request time limits still apply. This implementation imports
selective Hermes interaction ideas, not the Hermes runtime; see ADR 006.
