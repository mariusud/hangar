# 0013. Tokens carry their own role

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amends:** [0004](0004-opaque-hashed-tokens-and-oidc-for-people.md)

## Context

A bearer token took the role of the account that made it, and an operator account's tokens also
got `install:upload`. Operators make most of the tokens for agents and CI jobs, so those tokens
could upload apps, make new tokens, change images and see every lease. Someone who stole one,
from a CI secret or an agent's environment, could install code that runs as the Mac's user.

A CI job that builds a pull request runs that pull request's code, and with an upload token it
could upload a build under the name an image follows. Every device leased from that image would
then run it.

## Decision

- A bearer token acts as an operator only when it carries the `operator` scope and its account is
  an operator. `hangar up` and `hangar login` give the operator's own CLI token that scope.
  Agent tokens cannot carry it.
- No token gets `install:upload` from its account. It is a scope an operator grants.
- `install:upload:<prefix>` allows uploads only under names that start with the prefix, for jobs
  that run code from a pull request. `hangar connect ci <prefix>` makes one.
- When the broker starts, existing tokens labelled `hangar up on ...` or `CLI on ...` on an
  operator account get `operator` and `install:upload`. Every other existing token becomes a
  member's.

Console sessions keep the account's role.

## Consequences

An agent or CI token from an operator no longer sees other people's leases or changes settings.
A booking token does not upload builds; the app is uploaded first with a CI token or put in the
image. A team that gave an agent an operator's token for uploads makes a CI token for that job.
