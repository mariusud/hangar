# Hangar

The fastest way for React Native and Expo teams to give every developer, QA tester, CI job and
AI agent a fresh iOS simulator from a Mac mini in the office. One command turns the Mac into a
pool of simulators that people and programs lease, drive in the browser at 60 fps, and give
back. Every device is wiped before the next person gets it.

**Status: early. It runs on one Mac with iOS simulators.** Nothing is published to npm yet, so
run it from a clone. The plan is in [ROADMAP.md](ROADMAP.md) and the design in
[docs/design.md](docs/design.md).

```bash
pnpm install
pnpm hangar up
```

Open the sign-in link it prints, invite your team from the People page, and they are using
simulators in the browser.

## What works today

- `hangar up` on a Mac with Xcode and idb: checks the machine, keeps a warm pool of simulators
  sized from memory, and prints a one-use admin link. `hangar doctor` runs the checks alone.
- Leases with a fair queue, TTL, idle timeout and renew. Two clients never get the same device.
  A released device is deleted and replaced with a fresh clone, so nothing survives a lease.
- A REST API: screenshot, accessibility tree, batched actions (tap by element or point, swipe,
  type, key, button, wait for an element), install a `.app`, launch, terminate, open URL.
- A console: invite links and passwords, the device list, a live screen in H.264 at 60 frames
  per second (JPEG on plain-HTTP pages) with touch and keyboard, install and open URL.
- MCP at `/mcp` with the same tools, for AI agents.
- A TypeScript client (`@hangar/client`) and a CLI: `login`, `lease`, `screenshot`, `ui`, `tap`,
  `type`, `install`, `launch`, `open-url`, `watch`, `release`.

Not yet: running as a
service that survives a reboot, recordings, metrics, `hangar run ios` with your own Metro,
Android, more than one Mac, CI test runs. Only one Hangar can run on a Mac at a time.

## Numbers

From `pnpm bench:stream` on an M4 Pro with Xcode 26.6 and an iPhone 17 simulator at 1206 by
2622, through the real broker and agent ([baseline](bench/stream.baseline.json)). The targets
are in [the design](docs/design.md#targets).

| | H.264 (HTTPS, localhost) | JPEG (plain-HTTP LAN) | Target |
|---|---|---|---|
| Frame rate during motion | 58 fps | 6 fps | 60 fps |
| Capture to client | 8.9 ms p50, 19.9 ms p95 | not measured | |
| Input to first changed frame | 86 ms p50, 339 ms p95 | 228 ms p50, 669 ms p95 | p95 under 80 ms |
| Bandwidth during motion | 691 KB/s | 195 KB/s | |

Decoding in the browser adds about 2 ms (3 ms p95). The input p95 is not met yet. Comparisons
with other tools on the same hardware will be added here when they are measured.

## What it is for

- **Manual QA.** Pick a device in the browser, install a build, test it by touch, and file a bug
  with the recording attached.
- **Test suites.** Shard Maestro and XCUITest suites across the fleet from CI and get JUnit back,
  or point an existing Appium suite at Hangar's endpoint.
- **AI agents.** Lease a device over MCP or the REST API, read the screenshot and accessibility
  tree, tap by element, and release it.

## How it works

```
 browser, CI, agents ──HTTP(S)──> broker <──WebSocket── agent (Mac mini) ── simulators
                                                         agent (Linux)    ── emulators, phones
```

On one Mac, the broker and the agent run in the same process. A bigger team moves the broker into
a container. Agents connect out to the broker, so hosts need no inbound ports. Every call goes through the
broker and the agent, which only serves the leased device and refuses anything else. Video is
H.264 from the simulator's display, encoded in hardware on the Mac.

## What it is not

- Not a hosted service. You run it on hardware you own, for your own development and testing.
  Read Apple's macOS license for what that allows.
- Not a sandbox for untrusted code. An iOS simulator app runs as a process on the Mac. Hangar
  isolates leases at the API level and keeps app uploads behind a permission; teams that do not
  trust each other's code should use separate Macs. See the
  [security model](docs/design.md#7-security-model).
- Not a new test framework. It runs the ones you already use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Hangar sends no telemetry and runs without internet access.
