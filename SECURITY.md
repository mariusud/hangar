# Security policy

Hangar runs on your own network and hands devices to people and programs with different
permissions, so a hole in lease isolation or authentication affects every installation.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's
private vulnerability reporting on this repository (the Security tab, "Report a vulnerability").

Include what you can of:

- The affected part (`broker`, `agent`, a driver, `console`, `client`, `cli`) and the version or
  commit.
- What an attacker could do.
- Steps to reproduce.
- The deployment: how the broker is exposed, which OIDC setup, which host OS and Xcode.

## What counts

The security model is in [docs/design.md](docs/design.md#7-security-model). In particular:

- In scope: reaching a device or lease you do not hold, running a command on a host through the
  API, a token doing more than its role and scopes allow, data from one lease surviving the wipe.
- Known and documented, so not a vulnerability by itself: an app or test bundle installed on an
  iOS simulator runs as a process on the Mac. Uploads need the `install:upload` scope for this
  reason.
- Out of scope: hostile operators, physical access to hosts, an attacker who already has a shell
  as the `hangar` user.
