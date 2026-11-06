# 0004. Opaque hashed tokens, built-in accounts by default, OIDC as an option

- **Status:** Proposed
- **Date:** 2026-11-05

## Context

The broker is the only party that checks tokens, and revoking one must take effect at once.
Setup must not need an identity provider, but teams that have one expect single sign-on. Simlock trusts a sign-in proxy header; tapflow uses passwords and
invites.

## Decision

Tokens are `hgr_<kind>_<32 random bytes, base32>`, with kinds `member`, `host`, `stream` and `join`. A
token has an owner (a person or a team), a role (`member`, `team-admin`, `operator`), optional
scopes such as `install:upload`, and an optional expiry. The broker stores the SHA-256 hash, shows
the token once, and looks it up on every request. Stream tokens are bound to one lease and expire
5 minutes after minting if unused.

People sign in with built-in accounts by default: `hangar up` prints a one-use admin link, admins
invite people with links that carry a role, and each person sets a passkey or a password. OIDC
(authorization code with PKCE) is one setting away, with OIDC groups mapped to teams and roles. A
trusted sign-in proxy header is the third option. All three end in a session cookie.

## Consequences

- No JWT signing keys to manage or rotate.
- Every request costs one indexed lookup.
- The prefix lets secret scanners recognise leaked tokens.
