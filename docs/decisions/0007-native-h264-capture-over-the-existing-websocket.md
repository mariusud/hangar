# 0007. Native H.264 capture, sent over the existing WebSocket

- **Status:** Accepted. Supersedes the transport part of 0003.
- **Date:** 2026-11-05

## Context

The JPEG stream from milestone 1 takes a screenshot with `simctl`, scales it with `sips` and
sends it base64 in JSON. Measured on a Mac with Xcode 26.6 and iOS 26.5: 6 frames per second,
155 ms median and 269 ms p95 from the start of a capture to a finished JPEG. Hangar's target is
60 fps and under 50 ms glass to glass.

Xcode 26.6's SimulatorKit exposes each simulator display as an IOSurface, with callbacks for
damage rectangles and for surface changes (`SimDisplayIOSurfaceRenderable`,
`SimDisplayRenderable`). idb and Software Mansion's simulator-server read the screen the same
way. It is a private API and can change with Xcode.

## Decision

- A Swift helper, `hangar-screen`, reads the IOSurface, encodes with VideoToolbox H.264 in
  low-latency mode (no frame reordering, keyframes only on demand) only when the display reports
  damage, and writes length-prefixed frames with a capture timestamp to stdout. It sends two
  refresh frames after motion stops so the encoder can sharpen the last picture.
- The helper is built from source with the Xcode toolchain the first time it is needed, so the
  repo ships no binaries and the build matches the installed Xcode.
- Frames go over the WebSocket the agent already has, then the console's WebSocket, unchanged.
  The console decodes them with WebCodecs where the browser offers it (HTTPS, localhost) and
  falls back to the JPEG path elsewhere.
- WebRTC is not built now. It stays an option for plain-HTTP LAN pages and for lossy networks.

## Measurements

Same Mac, a cloned iPhone 17 simulator at its native 1206 by 2622:

| | JPEG path | `hangar-screen` |
|---|---|---|
| Frame rate during motion | 6 fps | 60 fps |
| Frames while idle | 6 fps | none |
| Capture to encoded frame | 155 ms p50, 269 ms p95 | 7.8 ms p50, 8.6 ms p95 |

## Consequences

- When a new Xcode changes the private API, the helper exits with a `SIMULATORKIT_CHANGED`
  error, and the agent falls back to JPEG. CI runs the helper against every supported Xcode.
- A plain-HTTP LAN page gets JPEG until question 6 in the design is decided.
- Touch, key and button input go to the idb companion over gRPC on one HTTP/2 session per
  device (Node's `http2`, a hand-written encoder for the few HID messages, checked against idb's
  own serialization). A tap reaches the companion in 2 to 9 ms, against 285 to 354 ms with the
  idb CLI. Typing still uses the CLI.

## Update, 2026-11-06

`pnpm bench:stream`, through the real broker and agent, a scroll gesture as input:

| | H.264 | JPEG |
|---|---|---|
| Frame rate during motion | 58 fps | 6 fps |
| Capture to client | 8.9 ms p50, 19.9 ms p95 | |
| Input to first changed frame | 86 ms p50, 339 ms p95 | 228 ms p50, 669 ms p95 |

The input p95 misses the 80 ms target. The worst trial includes opening the gRPC session, and
part of the rest is the simulator's own touch handling; separating the two is next.
