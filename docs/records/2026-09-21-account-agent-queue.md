# Account-to-Mac agent queue

Status: implemented source slice; local verification required before release.

An authenticated account workspace can now queue a bounded HII objective from
the canvas command palette. The request is stored as an ordinary synchronized
workspace object with its intent, selected object ids, requester, timestamp,
status, audit trail, output, and eventual receipt path.

The linked desktop app observes queued objective objects through the existing
account workspace persistence adapter. It claims the request on the Mac and
starts it through the existing approved-context `agent_start` path. Progress,
completion state, and the receipt path are written back to the same object and
therefore become visible in the authenticated web workspace on its next sync.

Security boundary:

- the browser can queue or revise governed intent; it cannot invoke a native
  shell or write to a PTY;
- `terminal_start`, `terminal_write`, `terminal_resize`, and `terminal_stop`
  remain Tauri-only;
- the linked Mac compiles and approves the bounded ContextPack before execution;
- cancellation remains a local executor action until a signed, revocable
  remote-control contract exists.

This is a durable work queue, not proof that work continues after the desktop
app or Mac is shut down. Runtime survival across app restarts needs a separate
CLI-owned supervisor and replayable run-status API.
