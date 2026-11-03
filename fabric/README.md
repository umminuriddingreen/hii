# HII machine fabric

This directory holds the first bounded endpoints for ADR 005's user-owned,
cross-device inference surface:

| Package | Current proof | Explicit boundary |
| --- | --- | --- |
| `protocol/` | Versioned, bounded MessagePack control protocol with deny-by-default authority claims and frame-layout validation | No transport security, pairing, or live grant validation |
| `macos-capture/` | ScreenCaptureKit display discovery and latest-frame NV12/BGRA capture with stride, clock, color-range, and health metadata | No encoding, transport, audio, or input |
| `windows-receiver/` | Bounded frame/session lifecycle, latest-frame mailbox, health telemetry, and Windows D3D11 device boundary | No transport, decode, swap chain/presentation, input executor, or service bridge |

These packages are intentionally independent while their OS toolchains and
wire contract stabilize. They do not establish a live Mac-to-Windows link and
must not be presented as remote observation or execution proof.

Run the focused local proof from the repository root:

```sh
npm run fabric:check
```

The next integration slice is an authenticated, device-bound transport adapter
that maps captured plane metadata and payloads into one negotiated display
channel, without trusting serialized authentication or authority claims.
