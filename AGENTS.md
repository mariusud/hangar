# AGENTS.md

Rules for coding agents working in this repository. Each package will add its own `AGENTS.md`
for what is specific to it.

## What Hangar is

A self-hosted device fleet: a broker and an agent in one process on the first Mac (or the broker
in a container for bigger setups), an agent on each other host, devices leased to people, CI and
AI agents. The design is [docs/design.md](docs/design.md); read the sections that
touch your change before writing code. Decisions are in [docs/decisions/](docs/decisions/).

## Easy to use comes first

A change that adds a required setting, service, port or manual step needs a default that makes it
unnecessary for a single Mac. Errors say what happened and what to do next. Read "Easy to use
comes first" in the design before adding a feature.

## Fast, and measured

Hangar's goal is to be the fastest remote simulator for React Native teams. The targets are in
the design under "Targets".

- Measure before optimizing. A performance change shows before and after numbers from a script
  in the repo, and the README numbers stay true.
- Hot paths are native: capture, encode and input. No process spawn, JSON or base64 per frame
  or per tap. Everything else is TypeScript on Node 22 with no build step.
- Never queue video. Drop stale frames and send a keyframe instead.

## Rules that protect the design

- The broker never imports a driver package. It only talks to agents through `packages/protocol`.
- No message type, API route or MCP tool accepts a device UDID, a host path or a shell command.
  The agent looks devices up in its own lease table.
- Drivers call tools with `execFile` and an argument array. Never a shell.
- The lease and device state machines and the scheduler are pure functions. Keep clocks, I/O and
  the database out of them so the property tests can run them.
- A device returns to the pool only after a verified wipe.
- Nothing calls out to the internet. No telemetry.

## Writing

- Docs describe what exists. Planned work goes in `ROADMAP.md`, not in user docs.
- Plain sentences, no marketing language.
- A decision that changes the design gets a new file in `docs/decisions/` that supersedes the
  old one.
