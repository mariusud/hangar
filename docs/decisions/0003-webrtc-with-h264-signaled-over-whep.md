# 0003. WebRTC with H.264, signaled over WHEP

- **Status:** Superseded in part by 0007, which sends native H.264 over the existing WebSocket. WebRTC remains an option, not the plan.
- **Date:** 2026-11-05

## Context

People watch and drive devices from the console. Relaying video through the broker costs
bandwidth and latency. tapflow sends H.264 over WebSocket and decodes it with WebCodecs; Simlock
sends H.264 over HTTP in its own framing. The hardware encoder gives H.264. Every current browser
decodes H.264 in WebRTC; VP8 would need a software encoder per device.

## Decision

The host sends WebRTC media straight to the viewer. Signaling is WHEP, forwarded by the broker to
the host over its WebSocket. Video is H.264 from `idb video-stream` (VideoToolbox), packetized
with node-datachannel. One encoder per device, shared by all viewers. Input from the console goes
back over a data channel, accepted only from the lease holder's session. No VP8 until a browser we
need cannot play H.264.

When WebRTC does not connect within 3 s, the console falls back to JPEG frames over the broker's
WebSocket, which the agent already holds open. JPEG, not H.264, because decoding H.264 there needs
WebCodecs, which browsers only allow on HTTPS pages, and single-Mac mode serves HTTP.

## Consequences

- No custom signaling protocol; any WHEP client can watch with a stream token.
- On a LAN the browser reaches the Mac over UDP, so the Mac firewall must allow the agent's UDP.
- Watching works on any network with no TURN server, at lower quality on the fallback. A TURN
  server (coturn example in the deploy files) restores full quality across networks.

## Update, 2026-11-05

Measured on a Mac with Xcode 26.6 and the idb companion from Homebrew:

- `idb video-stream --format h264` works. `--format mjpeg` produces no bytes.
- JPEG screenshots over the broker's WebSocket reach about 8 frames per second, which is enough to
  drive a device by hand, and they work on plain HTTP and on any network.

So milestone 1 ships only the JPEG path, and the console uses it for everyone. The WebRTC path
above is the next step for smooth video, not a requirement for milestone 1.
