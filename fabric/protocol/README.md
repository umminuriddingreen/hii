# HII Fabric Protocol

This standalone Rust crate is the first bounded control-plane substrate for
HII's user-owned Mac/Windows machine fabric. It defines versioned message types
and a length-delimited MessagePack frame. It does **not** connect devices,
capture displays, inject input, expose ports, transfer files, open terminals,
or run jobs.

## Wire framing

Every frame has a 12-byte, big-endian header followed by one MessagePack
`Envelope`:

| Bytes | Meaning |
| --- | --- |
| `0..4` | ASCII magic `HIIF` |
| `4..6` | wire version (`1`) |
| `6..8` | reserved flags (must be zero) |
| `8..12` | payload length as `u32` |
| `12..` | named MessagePack payload |

`FrameCodec` rejects bad magic, unknown versions, non-zero flags, malformed or
truncated frames, trailing bytes in single-frame decode, and lengths above its
configured bound before allocating the payload. The default is 8 MiB and the
hard ceiling is 16 MiB. File chunks have an additional 4 MiB bound.

The codec is blocking and depends only on `Read`/`Write`. QUIC, TLS, USB4 IP,
Thunderbolt IP, and ordinary Ethernet adapters can use the same header; async
adapters should reproduce these exact validation rules.

## Security and truth boundaries

- This crate contains no encryption and invents no pairing cryptography.
- A `LinkAuthentication::Authenticated` message is not proof that its sender is
  authenticated. The secure transport adapter must establish peer identity,
  bind it to the HII device record, and provide the verified session state.
- `DeviceHello`, display names, capabilities, transport bindings, digest
  strings, receipt references, and timestamps are untrusted input until the HII
  runtime verifies them.
- `AuthorityContext` is a reference to a runtime-owned grant, not the grant
  itself. The default is empty and denies every consequential action. Even a
  populated authority claim must be checked against the live, unexpired,
  revocable grant on the receiving device.
- Input injection, file mutation/transfer, clipboard mutation, service
  exposure, terminal opening, and jobs require explicit authority. Terminal
  requests name one device, working directory, expiry, and bounded PTY size;
  the device executor must still verify that exact live grant. Service exposure uses a typed,
  non-zero loopback endpoint; arbitrary or wildcard hosts are not representable
  and there is no blanket localhost exposure message.
- Health, receipt observation, and display/audio observation are read-only at
  this protocol layer, but still require an authenticated and scoped device
  link under ADR 005.
- Frame metadata carries explicit sender-clock semantics, raw plane strides and
  color range so adapters do not relabel macOS monotonic/media timestamps as
  Unix time or assume tightly packed GPU buffers. It is still only metadata.
  Codec payloads and GPU/video surfaces should
  use independently bounded data channels and must not be represented as live
  unless transport and executor evidence exists.
- File digests and chunk digests are declarations. The transfer executor must
  calculate and compare them before acknowledging `CompleteVerified`.
- Receipt references are links to proof, not proof themselves.

Malformed frames and protocol-version mismatches should close the connection;
continuing after a fatal framing error risks stream desynchronization.

## Integration requirements

Before this crate can carry real HII work, the parent runtime needs:

1. an authenticated transport with certificate/key storage, pairing UX,
   revocation, replay/session handling, and a verified device identity binding;
2. CLI-owned capability and authority lookup that validates every consequential
   message against a live grant rather than trusting serialized claims;
3. per-channel state machines, quotas, timeouts, cancellation, backpressure,
   latest-frame behavior, and audit events;
4. OS-specific Mac and Windows executors for capture, render, input, filesystem,
   localhost proxying, approved PTYs, and bounded jobs;
5. digest calculation, resumable transfer state, safe destination handling, and
   atomic finalization for files;
6. receipts created from executor-returned evidence and exposed as durable HII
   objects; and
7. interoperability fixtures once another language or process implements the
   wire contract.

Run the focused proof with:

```sh
cargo test --manifest-path fabric/protocol/Cargo.toml
```
