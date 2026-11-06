# 0001. TypeScript on Node 22 for every package

- **Status:** Proposed
- **Date:** 2026-11-05

## Context

Hangar has a broker, a host agent, drivers, a console, an SDK and a CLI. The broker and the agent
exchange messages whose shape must stay in step. Most clients (agent frameworks, Argent, Maestro
wrappers, CI scripts) are JavaScript or TypeScript. The drivers are external processes (`simctl`,
idb, adb, scrcpy, `xcodebuild`), so the agent's language does not limit what it can drive.
Simlock and tapflow already drive simulators and stream H.264 from Node.

## Decision

Every package is TypeScript on Node 22, in one pnpm workspace. The wire types live in
`packages/protocol` and both the broker and the agent import them.

## Consequences

- A change to a message shape fails the type check on both sides in the same pull request.
- The WebRTC path depends on node-datachannel, a native addon with prebuilt binaries. If that
  becomes a problem, werift (pure TypeScript) is the fallback, with our own RTP packetizer.
- Contributors need one toolchain.
