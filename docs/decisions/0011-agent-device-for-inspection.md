# 0011: agent-device for what Hangar's driver does not do

Status: Replaced by [0012](0012-bookings-priority-and-held-devices.md). Measured in a spike on
2026-11-09; nothing in Hangar uses it.

## Context

Hangar drives iOS simulators through the idb companion and its own Swift capture helper. That
covers the screen, the element tree, taps, swipes, typing, keys, buttons, waiting for an
element, apps, URLs, push, permissions, location, appearance, locale, Maestro, recordings and
Metro.

An agent that debugs an app needs more: app and network logs, performance samples, JavaScript in
the running app, pinch and rotate, alerts and orientation. The agent that would move from argent
to Hangar uses all of these. Building each one into Hangar's driver would repeat work that two
other projects have done:

- **argent** (Software Mansion). Its simulator server and native libraries ship as proprietary
  binaries, and telemetry is on by default. Hangar is Apache-2.0 and makes no calls to the
  internet, so argent cannot be a dependency.
- **agent-device** (Callstack, MIT, about 5,300 stars, version 0.21.36). It is one npm package
  of 7.4 MB with no dependencies. `startAgentDevice({ stateDir })` runs it inside another process,
  and every command takes a `udid`. Its client covers:
  - observability: perf, logs, events and network;
  - interactions, including pinch, rotate, fling and fill;
  - alerts, orientation, React Native commands, Metro reload, replays and traces.

## What the spike measured

On the office Mac mini (M4, 16 GB, Xcode 26.6, iOS 26.5), the spike leased an iPhone 17 from
Hangar, drove the same simulator with agent-device inside one Node process, then released it.

| | agent-device | Hangar |
|---|---|---|
| Start | 147 ms in process | already running |
| First command | 4.0 s, starting its XCTest runner | none |
| First command ever on a Mac | 37 s, to build the runner once | none |
| Element tree | 375, 234 and 202 ms | 404, 90 and 107 ms over HTTP |
| First press | 10.2 s, 9.1 s of it waiting for the runner | none |
| Later presses | 417 to 690 ms | 258 to 635 ms |
| Memory per device | about 290 MB (xcodebuild, a snapshot bridge, simctl) | none extra |

Its element tree on Settings had 18 nodes with roles, labels, frames and refs. After Hangar
pressed home, agent-device's next snapshot failed with "timed out while reading snapshot
viewport". The two drivers cannot act on one device at the same time.

The only internet call in the package is an update check in its CLI. `AGENT_DEVICE_NO_UPDATE_NOTIFIER`
turns it off, and the Node API does not call it. Cloud providers such as BrowserStack and Limrun
are contacted only when configured. The "telemetry" module writes gesture timings to a local file
next to a recording.

## Decision

1. Hangar's own driver stays for everything on the hot path: capture, input, the element tree,
   screenshots, installs and the wipe. Once its runner is up, agent-device presses about as fast
   as Hangar, but the runner takes 4 to 10 s to start per device and about 290 MB to keep.
2. A host may also offer agent-device for the operations Hangar does not have: logs, network,
   perf, JavaScript, pinch and rotate, alerts and orientation. The agent starts it for a lease
   on the first call that needs it, and stops its runner when the lease ends, before the wipe.
3. While agent-device runs on a lease, Hangar sends that lease's input through it, or waits for it
   to finish, so the two never act at once.
4. The API names these operations. It never takes a UDID, a path or an agent-device command line.
   The agent maps a lease to its UDID, as it does today.
5. agent-device is optional. A host without it answers `UNSUPPORTED`, and `hangar doctor` says how
   to add it. The agent sets `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` and passes no cloud settings.
6. A lease that uses agent-device counts its 290 MB against the host's capacity.
7. Making Hangar an agent-device provider plugin, so agent-device users can lease Hangar devices,
   is a separate decision.

## Open before this is accepted

- Building the runner when a host starts, as Hangar does with golden devices, so no lease waits
  37 s.
- Watching network traffic during a full run, to confirm no call leaves the Mac.
- Whether logs and network work on iOS simulators, which the spike did not call.
- Pinning a version, because agent-device changes fast. Its plugin format v1 goes away in 0.22.

## Consequences

Agents get the tools they need to debug through Hangar's leases, and Hangar keeps its pool,
wipes, stream and CI. Hangar now depends on a project from a company that also makes Simlock. If
agent-device changes direction, a host can drop it and Hangar keeps working without those
operations.
