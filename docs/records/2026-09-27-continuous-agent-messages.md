# Continuous embedded agent messages

Done:
- Personal workspace Send remains available during agent work; ordered follow-ups
  use the existing CLI agent-chat endpoint and scoped executor.
- Explicit Stop cancels active and queued turns for the selected chat.
- Atomic local turn records retain accepted text, IDs, and completion state;
  interrupted requests are not automatically replayed.
- Relay upload acknowledgments prevent request/upload/end reordering across
  asynchronous per-frame authentication. Byte counts and sequence checks reject
  incomplete uploads. Authority and authentication remain unchanged.
- Imported selective Hermes interaction ideas; no upstream runtime or code copied.

Verified:
- `node --test personal-workspace/*.test.mjs runtime/agents/chat-loop.test.mjs`:
  24 passed, zero failures.
- `npm run check`, script syntax checks, `git diff --check`.
- `npm run deploy`: build and Worker deployment succeeded.
- Live root returned HTTP 200; private asset without authentication returned 401.
- Signed-in Chrome on humaninformationinterface.com submitted a second message
  while the first was running. The Mac ledger showed running/queued, then two
  completed turns; the page displayed WEB_FIRST_OK and WEB_SECOND_OK in order.
- Same live page Stop showed two Message stopped responses; durable statuses
  were stopped for the active and queued cancellation tests.
- Concurrent installed `hii agents chat send` calls both completed through the
  same local queue. Local isolated UI also returned two ordered model replies.
- Canonical Mac service and authenticated bridge restarted; bridge now loads
  source from /Users/ummi/hii instead of the older private-workspace checkout.

Not Verified:
- Physical iPhone Safari interaction and crash recovery with in-flight tools.
- Full Hermes fork, Rust rebuild, signed desktop release, and Git remote push.

Proof:
- Source commits b3cc7194 and 10e92c7f, integrated locally into main.
- Worker deployment 76ec297d-36d6-4875-823b-14e8e3d470b5.
- Local live proof chat 8f164ea7-1b2d-461b-9db7-a85ed8af1399.
- ADR 006 and focused backend, frontend, and relay tests.

Risk:
- Single executor serializes turns; at most 16 pending messages per chat.
- Existing request deadlines apply. Disconnect cancels work on that stream;
  the operator reviews interrupted records before retrying.
- Installed Node dependencies predate package.json: Next 14.2.35 produced
  lockfile-patching warnings, but the build, typecheck, and deployment completed.

Next Command:
`hii agents chat show 8f164ea7-1b2d-461b-9db7-a85ed8af1399`
