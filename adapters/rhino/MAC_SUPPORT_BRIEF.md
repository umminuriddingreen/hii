# HII Rhino — macOS support brief

Handoff brief for an agent session. Written on Windows against
`rhino/hii-rhino-bridge` (pushed to `origin`), where the bridge is verified
live at 41/42 acceptance checks.

## What exists and works today (Windows only)

The chain `HII CLI → facade → named-pipe IPC → .rhp → UI-thread dispatch →
RhinoCommon → event/state confirmation → independent postcondition query →
receipt → native undo` is proven end to end against live Rhino 8. Acceptance
harness: `adapters/rhino/ipc/examples/acceptance.rs`.

Eight operations ship, advertised as capabilities
`["rhino.session", "rhino.document", "rhino.geometry", "rhino.mutate", "rhino.undo"]`.

## Standing constraints — these are not negotiable

Carried forward verbatim from the governing directive. An agent that breaks
one of these has produced work that must be thrown away.

- Do **not** base any of this on Termite, RhinoGhAgent, `rhino_mcp`,
  `rhinomcp`, or `C:\Users\ummin\rhino`. Those are inspect-only. Do not port
  `GrasshopperActionExecutor.cs`. Leave `termite.rhino.managed_job` and
  `termite.rhino.installer_action` untouched.
- Do **not** weaken or remove the existing instance-ID check.
- Do **not** leave the event queue conceptually unbounded.
- Do **not** add Grasshopper anything. It is gated behind full verification of
  checkpoint F.
- Do **not** add `rhino.run_python_script`.
- No agent, prompts, llama.cpp integration, or semantic planning inside Rhino.
- No tool exposed before its implementation exists.
- No failures hidden behind generic retries.
- No unrelated refactors.

## The actual portability blockers

Three, and only three. They are known and located.

### 1. Rust transport — `adapters/rhino/ipc/src/connection.rs`

The Windows implementation is real; the Unix side is a deliberate stub that
returns `BridgeUnavailable` with *"the HII Rhino bridge transport is
Windows-only in this build"*. The `#[cfg(not(windows))]` block near the end of
the file is the whole surface to implement.

Windows-specific pieces that need a Unix answer:

- `PipeConnection` over overlapped Win32 I/O → Unix domain socket.
- `Canceller` → whatever cancels a blocking read on the chosen primitive.
- `open_pipe`'s `GetNamedPipeServerProcessId` check. **This is a security
  control, not a convenience.** It runs before a single byte is written, so a
  process squatting the name never sees the handshake. On macOS the equivalent
  is `LOCAL_PEERPID` via `getsockopt`. If it cannot be done, say so explicitly
  rather than dropping the check silently — and note that the handshake's
  instance-id comparison catches a *different* thing and does not substitute.
- Socket path: a Unix domain socket path is filesystem-permissioned. Place it
  under the user-only directory and set the mode accordingly; that is the Unix
  analogue of the pipe DACL, and it must actually restrict to the current user.

Framing, `MAX_MESSAGE_BYTES = 8 MiB`, validate-before-allocate, and the demux
layer are OS-free and must not change.

### 2. C# transport — `adapters/rhino/bridge/src/HiiRhino.Core/Transport/`

- `BridgeServer.cs` is marked `[SupportedOSPlatform("windows")]` and calls
  `NamedPipeServerStreamAcl.Create(...)` with `PipeSecurityFactory.CurrentUserOnly()`.
- `PipeSecurityFactory.cs` is entirely Windows ACL code.

Both need a macOS path. `UnixDomainSocketEndPoint` + a `Socket` listener, with
the socket file created under a directory the current user alone can enter.
Keep one transport interface so `Hosting` and `Operations` do not learn which
OS they are on.

### 3. Target frameworks

`src/*/*.csproj` build to `$(RhinoTargetFramework)`, which resolves to
`net7.0-windows`. `tests/HiiRhino.Core.Tests` is pinned to `net8.0-windows`.
Rhino 8 on macOS also runs .NET Core, so this becomes a multi-target or a
conditional property. `ExcludeAssets="runtime"` on RhinoCommon and
`EnableDynamicLoading` stay as they are.

## Protocol compatibility is a hard requirement

`adapters/rhino/protocol` is OS-free by design and is hand-mirrored in C#.
Golden fixtures in `adapters/rhino/tests/golden/` are compared byte-for-byte as
a cross-language oracle, and C# uses
`JavaScriptEncoder.UnsafeRelaxedJsonEscaping` so its output matches
`serde_json`. **A macOS build must produce byte-identical frames.** If a golden
fixture has to change, that is a protocol change and needs to be called out, not
absorbed.

## What can and cannot be verified where

- **On Windows:** the Rust workspace compiles and its tests pass; the C# core
  tests pass. Cross-compilation checking of the Unix path is possible with
  `cargo check --target x86_64-apple-darwin` only if the toolchain is present.
- **On macOS only:** the actual acceptance sweep. It needs Rhino 8 running with
  the `.rhp` installed, and the user typing `Hii` — `/runscript` is proven
  non-functional on this install, so the command cannot be automated.

Do not report macOS support as working on the strength of a compile. The
acceptance harness is the standard of proof, and it has to run there.

## Known environment traps

- The `.rhp` is DLL-locked while Rhino is running. A reinstall requires Rhino
  closed. For compile-only checks use
  `dotnet build … -p:OutputPath=<scratch>` — note `-p:BaseOutputPath` causes
  duplicate-assembly-attribute errors, so `OutputPath` is the correct flag.
- `RhinoDoc.UndoActive` means "an undo is in progress", **not** "an undo is
  available". The sibling is `UndoRecordingIsActive`. This misreading already
  cost a session.
- `document.Objects.Count` includes deleted-but-unpurged objects. Use
  `DocumentAccess.LiveObjectCount`. Every count in the bridge agrees on
  `DocumentAccess.LiveObjects`.

## Branch and repo state

- The work is on `origin/rhino/hii-rhino-bridge`. `origin/main` contains **no**
  `adapters/` at all and has diverged (this branch is 29 ahead / 149 behind the
  current `main`). Branch from `rhino/hii-rhino-bridge`, not from `main`.
- There is also a `mac` remote: `ummi@mac:/Users/ummi/hii`.

## Suggested first move

Do not start by writing the Unix socket. Start by making the failure honest and
the scope visible:

1. Multi-target the projects so a non-Windows build is even attempted, and
   record what breaks.
2. Implement the Rust Unix transport against the existing tests in
   `adapters/rhino/ipc/tests/` before touching C#.
3. Only then the C# listener, held to the golden fixtures.
4. Hand the acceptance sweep back to the user to run on the Mac.
