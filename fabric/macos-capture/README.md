# HII macOS capture prototype

This standalone Swift package is the bounded Mac display-capture edge of HII's
machine-fabric direction. It discovers displays and captures one explicitly
selected display through ScreenCaptureKit. Complete frames enter a single-item
latest-frame slot: when the consumer falls behind, the pending frame is replaced
instead of queued.

## Build and test

Requirements: macOS 13 or later, Xcode Command Line Tools, and Screen Recording
permission for the built executable or the terminal that launches it.

```bash
cd /Users/ummi/hii-newest/fabric/macos-capture
swift test
swift build -c release
.build/release/hii-macos-capture list --request-access
```

`--request-access` is deliberately opt-in because it can show a macOS permission
prompt. Without it, missing permission produces a clear denial and System
Settings path. After granting access, macOS may require the terminal or
executable to be restarted.

Capture requires an explicit display, geometry, rate, and pixel format:

```bash
.build/release/hii-macos-capture capture \
  --display-id 1 --width 1920 --height 1080 \
  --fps 60 --format nv12 --seconds 10 --queue-depth 2
```

The process writes newline-delimited JSON metadata for frames taken by its local
consumer, followed by one health snapshot. Pixel buffers remain GPU/IOSurface-
backed `CVPixelBuffer` values inside the process and are neither serialized nor
saved.

## Current contract

- Formats: NV12 video-range or BGRA.
- Metadata: display and sequence identity, dimensions, plane layout/stride,
  NV12 video/full color range,
  presentation timestamp, ScreenCaptureKit display time when present, monotonic
  receive time, and content scale fields.
- Health: complete and non-complete frame counts, producer-side replacement
  drops, average receive rate, last-frame age, and a one-second stall signal.
- Backpressure: one pending frame only; a newer frame replaces an unconsumed one.
- Scope: observation only. No network transport, input injection, audio, file
  access, service exposure, remote executor, persistence, or authority grant.

## HII integration seam

`CapturedFrame` is the ownership boundary for a future authenticated device
executor. A transport adapter can take the latest frame, use `metadata` as the
shared frame envelope, and encode or copy `pixelBuffer` without changing capture
policy. The shared protocol should assign link/session identity, codec and color
metadata, acknowledgements, receiver presentation time, authorization, and
receipts. Those fields intentionally do not exist here rather than being
fabricated by a local capture process.

## Evidence boundary

`swift test` verifies configuration validation, latest-frame replacement, and
health calculations. Successful local capture proves only that ScreenCaptureKit
delivered buffers on this Mac under the current permission state. It does not
measure capture-to-display latency and does not prove Windows transport,
decoding, presentation, USB4/Thunderbolt interoperability, authentication,
revocation, near-native performance, or any remote HII capability.

On 2026-08-18, a bounded local smoke on this Mac requested 640x414 at 30 fps for
0.4 seconds. Both NV12 and BGRA delivered 12 complete frames with zero
non-complete frames; NV12 exposed two planes (640-byte strides) and BGRA exposed
one plane (2560-byte stride). The run observed one producer replacement for
NV12 and zero for BGRA. This proves format delivery and metadata extraction, not
steady-state frame rate or end-to-end latency; the startup-weighted health rate
from such a short run is not a performance benchmark.
