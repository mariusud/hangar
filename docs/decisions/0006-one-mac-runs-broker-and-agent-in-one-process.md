# 0006. One Mac runs the broker and the agent in one process

- **Status:** Proposed
- **Date:** 2026-11-05

## Context

Most teams start with one Mac mini. Asking them to run a container, a database and an agent, and
to wire them together with tokens and TLS before they see a simulator, is the setup cost Hangar
exists to remove.

## Decision

`hangar up` runs the broker and the agent in the same Node process on the Mac, connected in memory
through the same `protocol` messages they use over the WebSocket. State is SQLite and artifacts
are on local disk. It installs itself as a LaunchDaemon, creates device classes from the installed
runtimes, sizes the pool from memory, and serves HTTP on the LAN with built-in accounts.

The container is the path for teams that outgrow one machine: `hangar export` on the Mac and
`hangar import` in the container move leases history, accounts, builds and settings. More hosts
on the same LAN can `hangar join` the first Mac without moving the broker.

## Consequences

- One setup path to test and document first; the container path reuses the same code.
- The in-memory transport must behave like the WebSocket one, including disconnects, so tests run
  both.
- Plain HTTP on the LAN means tokens and session cookies travel unencrypted until TLS is set up.
  The console shows a banner until it is, and `hangar config tls` or a reverse proxy fixes it.
- The first Mac is a single point of failure until the broker moves to a container. That is
  acceptable for small teams and stated in the docs.
