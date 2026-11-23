# 0016. Limits on leases per account and shards per run

- **Status:** Accepted
- **Date:** 2026-11-23
- **Amends:** the scheduling section of [the design](../design.md), which limits leases only by a team quota

## Context

A lease was refused only when the team had a quota and used it. A team without a quota, which is
the default, had no limit. One CI token could ask for hundreds of leases, or start a run with one
shard per flow, and fill the queue for everyone else. The scheduler is fair between teams and
priorities, but a queue of a thousand leases from one token still delays every other lease
behind it for as long as they take.

## Decision

- **An account may hold 50 leases that are queued, preparing or active.** `POST /v1/leases`, and
  every lease a run asks for, is refused with HTTP 429 and the code `TOO_MANY_LEASES` when the
  account is at the limit. The message gives the number held and the limit, and says to release
  some or ask an operator to raise the limit.
- **A run may have 50 shards.** `POST /v1/runs` is refused with HTTP 400 and the code
  `TOO_MANY_SHARDS` when the shards it would use, which is the number asked for or the number of
  flows if that is smaller, is above the limit.
- **Operators change both with environment variables.** `DEVICEPOOL_MAX_LEASES_PER_ACCOUNT` and
  `DEVICEPOOL_MAX_SHARDS` are read once when the broker starts. A value that is not a positive
  whole number is ignored. Nothing needs to be set on a single Mac.
- **The limit counts leases, not tokens.** Several tokens of one account share it. Leases of a
  booking count too, because a booking token belongs to an account. A run holds one lease per
  shard at a time, and a retry starts after the earlier lease is released, so a run of 50 shards
  fits exactly and a second run of the same account queues behind its own limit and fails with
  the 429 message.
- **The team quota stays.** It limits how many devices a team uses, and this limit protects the
  queue. Either can refuse a lease.

## Consequences

A team that runs more than 50 devices at once from one account needs the variable raised, or
several accounts. The refusal tells the person what to do, and the limit is high enough that
a person using devices by hand never meets it.

The same change makes a broker restart leave leases alone: a lease whose host has not said hello
yet is not ended as `device_lost` until the host grace period of 60 seconds after the broker
started has passed. This keeps the design's rule that hosts reconnect with their lease table and
the broker reconciles, and it needs no setting.
