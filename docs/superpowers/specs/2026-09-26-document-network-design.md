# HII shared documents and communication

Status: proposed design, prepared at the user's request. BlockSuite and BitChat are cloned and inspected; their integration is not implemented.

## Intent and working assumptions

The user wants a minimal, intuitive text-document surface shared by humans and agents, backed by HII CLI, available as an always-on local web app. They also want HII users and agents to communicate across networks and Bluetooth mesh. The latest dark chat screenshot defines the initial visual direction. Documents become durable working objects; conversations remain useful activities associated with them.

Assumptions: local personal use comes first; the existing HII canvas remains available as another projection of the same objects; LAN/Tailscale precedes BLE; internet relay use is optional. This design does not require a new account system or a fork of the complete AFFiNE or BitChat applications.

## Recommended experience

One page, one document, one small action bar. The header contains **hii**, the current document title (opens a searchable document picker), **New**, **Share**, and a quiet connection state. The body is a BlockSuite page editor with paragraphs, headings, lists, code, and attachment references. No persistent navigation sidebar, settings panel, database views, or agent dashboard in the first version.

A compact bottom input accepts questions and instructions about the document. Selecting text exposes **Ask**, **Improve**, and **Summarize**. The request scope is visible: “Selected text” or “This document.” The existing dark screenshot supplies color, spacing, user request bubbles, code presentation, and the composer shape. Typed text remains directly editable; command names and backend metadata stay out of normal product flows.

Agent responses appear as a reply or an inline proposed change. Proposed changes have **Apply**, **Dismiss**, and **Undo**. A document activity popover shows who changed what and the associated receipt. Users can grant an agent permission to edit a selected area for a bounded task; default document requests produce suggestions. Agents target stable document/block IDs through CLI operations rather than browser clicks.

Shared work adds a small **People** view inside Share. Incoming notes and suggestions identify both user and agent, e.g. “Sam · Research agent.” Messaging, document viewing, suggesting edits, and executing a task are separate permissions. The network view reports Nearby, Private network, or Internet only when observed.

## Architecture and ownership

```
BlockSuite web/Tauri editor       HII CLI/agents
           \                       /
              HII runtime owner
        documents • jobs • receipts • context
           /          |             \
    HII native      private LAN    optional Swift BLE
    inference       gateway        transport helper
```

HII owns runtime lifetime, database transactions, identity, permissions, inference, and receipts. The web UI is a projection served by the Rust runtime; it does not shell out a CLI subprocess per keystroke. CLI commands call the same owner through local IPC. Tauri uses the same document service. The existing native model runtime remains the inference executor.

Document bodies are persisted Yjs updates/snapshots in HII's SQLite database. HII owns their durable revision and commit sequence. BlockSuite is the schema/editor adapter; a HII-managed headless JS worker implements its production Workspace interface and semantic edits. It owns no database, network port, provider registry, or independent daemon lifecycle. Rust stages a proposed update, checks permission/revision/scope, commits it, then acknowledges/broadcasts it. Derived Markdown, search text, and block summaries are projections, never independent document-body writers. Existing Space objects reference document IDs without rewriting whole workspace JSON.

The current chat core has a lifetime exclusive database owner lock. Before exposing durable chat through the new always-on owner, migrate CLI and desktop chat access to that owner. Do not start a second chat writer or steal its lock. Document tables and service ownership must be deliberate; adding a separate document database merely to bypass that boundary is not the recommended design.

Human Yjs updates are scoped to one authorized document, size-limited, schema-checked in the headless worker, and committed through HII. Agent edits use semantic operations (`insert_block`, `replace_text`, `format_text`, `remove_block`) with `baseRevision`, allowed block IDs, and expected text where relevant. Stale agent edits return a conflict and a fresh bounded excerpt. CRDT convergence alone is not semantic conflict protection. Undo is a new scoped transaction preserving other actors' changes.

## CLI and always-on web app

Proposed commands, not shipped commands:

```
hii ui start [--open]
hii ui status --json
hii ui stop
hii doc new "Studio notes"
hii doc read DOC_ID --blocks BLOCK_IDS --max-tokens 4096
hii doc propose DOC_ID --patch-file patch.json
hii doc apply PROPOSAL_ID --expect-revision 12
hii doc export DOC_ID --format markdown
hii peer pair PEER_ID
hii message send PEER_ID --text "Review this paragraph"
hii message inbox --json
hii mesh start | status | stop
```

Use port 4188 for the local UI, preserving the current bookmark. `hii ui start` installs/starts a singleton per-user background service; closing the terminal does not stop it. The local listener binds loopback. Packaged static assets are versioned with the CLI. CLI, web UI, and Tauri connect to the same service and receive durable revision events. A web reload or service crash cannot turn an unsaved change into a Saved indicator. Saving acknowledgments follow database commit.

Authenticated remote communication uses the existing private HII network gateway, not exposure of the local UI listener. Add validated route handlers to the current gateway. Remote GUI availability and document access are separate explicit capabilities.

## Context and file handling

The working file-intake module already retains originals and extracts text privately under HII. It normalizes mislabeled HEIC images and runs separate native vision processing. Current attachment packets cap at 6,000 characters; recent chat text caps at 24,000 characters. Image descriptions are interpretations, not exact transcription or guaranteed understanding. Scanned PDFs currently inspect only page 1 and show that warning.

Document agent context adds a 4,096-token default pack: selected blocks first, then nearby headings, source references, and relevant retrieved excerpts. The pack records included/excluded blocks, document revision, and source IDs. Full documents, file binaries, and inbox history are not automatically inserted into every agent request. Agents can request another explicitly bounded slice. Attachments in a document carry HII file IDs; they are not base64 blobs embedded in conversation history.

## Communication model

Use one transport-neutral signed HII envelope with version, message ID, sender user/device/agent, recipient, type, correlation ID, document/block references, creation/expiry, bounded body, and content hash. Supported initial types: `note`, `task_request`, `proposal`, `result`, `ack`. Default limits: 4 KiB serialized envelope, 2 KiB body, 24-hour expiry. Persist inbox/outbox, deduplication, and delivery transitions in HII. A received task request is an inbox item; only a permitted collaboration scope can turn it into a local job.

Bind a peer's full cryptographic fingerprint to a paired HII user/device. An agent operates with a signed delegation describing its owner, document scope, permitted actions, and expiry. Key possession or a familiar display name does not establish HII authority. Revoke scopes without deleting conversation history.

Implement authenticated LAN/Tailscale first using HII's existing Rust TLS gateway. Transfer documents/assets on a separately authorized, bounded network channel. Small messages may carry previews and artifact hashes; paths on one user's disk are not remote retrieval capabilities.

BitChat supplies an optional BLE transport, not the complete product shell. Extract its Transport/BLE/fragment/Noise components into a native Swift helper controlled by HII's Rust process over local IPC. Its present executable package and coupling to Keychain, Nostr identity, scheduler, and file storage require a feasibility proof. Keep Nostr startup out of BLE initialization. Initial HII messages ride a negotiated prefix inside private text messages; do not repurpose media/group wire types. Standard BitChat clients may display this text but are not automatically HII agents or authorized document peers.

BLE carries small private messages, task proposals, and results. It is not the default channel for bulk Yjs histories, videos, or model weights. BitChat's default BLE fragments are 469 bytes with a nominal 512-byte maximum; its default TTL is 7, which is a relay budget, not a promised topology. Fragment/assembly/retry handling remains transport-owned; HII still enforces application limits and deduplication.

A native Apple BLE helper is the first Bluetooth target: source supports iOS 16/macOS 13 but is not a Windows or browser Bluetooth implementation. A Windows adapter is a later independent executor. Background iOS relaying remains an observed capability, not an assumed one. Internet/Nostr is a later explicit opt-in rail; BitChat's private Nostr envelopes are not generic NIP-17/44/59 interoperability.

## Alternatives considered

| Approach | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| HII-owned documents + BlockSuite editor + optional transport adapters | One durable state and agent contract; preserves canvas and CLI | Production Workspace adapter and owner migration needed | Recommended |
| Standalone AFFiNE/BitChat apps alongside HII | Fastest demos | Independent stores, identities, lifetimes, and authority | Reference/probe only |
| New custom Markdown editor with mesh embedded | Smaller initial editor | Reimplements editor behavior and mixes transport with document authority | Keep Markdown as export |

## Proof and release order

1. Pin and prove BlockSuite's production APIs at commit `5cb5cb68471ca692f3c162258f0087cb22fcb82d`; quick-start examples are stale for this checkout.
2. Prove one CLI-owned durable document through edit, reload, crash, restore, and concurrent actors.
3. Ship the always-on local document page and scoped agent suggestions.
4. Prove paired messaging/document proposals over real private-network devices.
5. Extract BLE at BitChat commit `9b84b36` and prove a private link on two actual Apple devices with Wi-Fi/internet disabled.
6. Claim mesh only after a third device demonstrably relays between endpoints unable to connect directly.

No BlockSuite dependency installation, native BLE build, Bluetooth permission change, device pairing, public message, or internet relay activation occurred during this planning pass.
