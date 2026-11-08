# 0008. The agent socket carries the in-process messages

- **Status:** Accepted. Supersedes the frame format in 0005.
- **Date:** 2026-11-07

## Context

0005 planned binary frames with an 8-byte header for screenshots and log batches, and HTTPS for
builds and recordings. By the time agents on other Macs were built, `hangar up` already passed
`AgentMessage` and `BrokerMessage` values between broker and agent in one process, with video
frames and Metro tunnel data as bytes and screenshots as base64 in responses.

## Decision

`/v1/agent/connect` carries exactly those messages. A message with bytes in `data` goes as one
binary frame: a 4-byte big-endian length, the rest of the message as JSON, then the bytes
(`encodeMessage` in `packages/protocol`). Every other message is a JSON text frame. The agent
authenticates with a host token in the `Authorization` header of the upgrade.

The broker sends paths, not full URLs, for builds to download and recordings to upload. Each
agent resolves them against the address it reached the broker at, so the same broker serves an
agent in its own process and agents across the network.

## Consequences

- One message type list for both transports, so the in-process path tests the remote one.
- Screenshots stay base64 inside JSON responses. That costs a third more bytes, which is fine for
  screenshots but would not be for video; video is already binary.
- Builds and recordings still move over HTTP, as 0005 planned.
