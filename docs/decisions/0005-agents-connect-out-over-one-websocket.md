# 0005. Agents connect out over one WebSocket

- **Status:** Proposed
- **Date:** 2026-11-05

## Context

Hosts sit on office or lab networks, often behind NAT, while the broker may run in Kubernetes
behind an ingress. tapflow and Simlock's gateway both have hosts dial out.

## Decision

Each agent opens one WSS connection to the broker's `/v1/agent/connect` and keeps it open. JSON
text frames carry requests, responses matched by `id`, and events. Binary frames carry
screenshots and log batches with an 8-byte header. Builds, test bundles and recordings move over
HTTPS with one-use URLs, not over the socket. The first message is `hello` with the protocol
version, host versions, capacity, memory, inventory and the agent's lease table, so a broker
restart can reconcile. The broker accepts the current protocol version and the one before.

## Consequences

- Hosts open no listening TCP port and need no firewall change for control traffic.
- Hosts can be upgraded one at a time.
- Not gRPC: a bidirectional gRPC stream through an ingress is harder to run and to debug than
  JSON over one socket.
