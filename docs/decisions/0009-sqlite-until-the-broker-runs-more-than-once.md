# 0009. SQLite until the broker runs more than once

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Milestone 3 lists Postgres next to the broker container. The broker reads and writes SQLite
through `node:sqlite`, which is synchronous: about 120 calls in the broker, including the lease
service that the scheduler runs on. The partial unique index on live leases is what stops two
leases from holding one device.

Postgres would need every one of those calls to become async, a driver dependency (Node has no
Postgres client of its own), and a second service to run and back up. The broker would still be
one process: leases, runs and the agent sockets live in its memory, so a second broker on the
same database would schedule the same devices twice.

## Decision

The broker keeps SQLite, in the container as on the Mac, on a volume. Builds and recordings,
which are most of the bytes, can already go to an S3-compatible bucket. Postgres comes when the
broker can run as more than one process, which needs leader election for the scheduler and a
way to reach agents connected to another broker. That is not planned yet.

## Consequences

- One broker per database, enforced by the Helm chart's single replica and `Recreate` strategy.
- Backups are `hangar export`, or a copy of the volume while the broker is stopped.
- Teams who require Postgres for every service have to wait for the multi-broker design.
