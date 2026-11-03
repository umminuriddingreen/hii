# HII Windows Receiver

This is a bounded, independent Rust scaffold for the Windows endpoint of HII's
user-owned machine fabric. It currently provides:

- an explicit receiver lifecycle and failure state;
- bounded frame metadata/payload validation;
- a latest-frame mailbox that drops superseded frames instead of queueing them;
- renderer, input, and explicitly exposed-service interfaces;
- health snapshots with component and mailbox telemetry; and
- a Windows-only D3D11 renderer boundary.

It does **not** currently implement transport authentication, protocol parsing,
video decode, D3D11 texture upload/presentation, remote input injection, audio,
file transfer, or localhost proxying. Calls into missing capabilities return
explicit `Unsupported` errors; the executable is not a working remote-display
receiver.

## Build and test

From this directory on macOS, Linux, or Windows:

```powershell
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

The cross-platform build exercises lifecycle, frame validation, mailbox, and
failure-reporting tests. On non-Windows systems, `cargo run` exits with an
unsupported-platform message.

On Windows with the stable Rust MSVC toolchain and Visual Studio Build Tools:

```powershell
rustup default stable-x86_64-pc-windows-msvc
cargo build
cargo run
```

The Windows executable currently creates a hardware D3D11 device and prints its
health. The D3D11 renderer reports `Degraded` because decode, a target window
and swap chain, texture upload, and presentation are not attached.

## Shared-protocol integration seam

Keep authentication, negotiation, and framing in HII's CLI-owned shared fabric
protocol. After that protocol validates a frame message, adapt its fields into
`FrameDescriptor`, construct `Frame::new`, and call `Receiver::ingest_frame`.
The receiver owns only bounded endpoint state and presentation policy; it must
not become a second authority store or transport daemon.

Expected protocol mapping:

| Shared frame field | Receiver field |
| --- | --- |
| authenticated stream identity | `stream_id` |
| monotonic per-stream sequence | `sequence` |
| negotiated dimensions/format | `width`, `height`, `format` |
| source capture timestamp + clock kind | `captured_at_ns` / `timestamp_clock` |
| raw plane stride/offset layout | `planes` |
| bounded message body | `payload` / `payload_len` |

Control messages should call `inject_input`, `expose_service`, or
`revoke_service` only after the shared protocol has authenticated the device and
the CLI-owned authority layer has approved that exact capability. The default
implementations remain unsupported so this crate cannot silently claim remote
control or port exposure.

Each receiver/mailbox instance binds to the first authenticated `stream_id` it
accepts. Frames for another stream are rejected, and the per-stream sequence
high-water mark survives frame consumption. A negotiated stream replacement
must create a fresh receiver/mailbox instance; this keeps delayed packets from
an old or unrelated stream from replacing current content.
