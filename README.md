# Hangar

The fastest way for React Native and Expo teams to give every developer, QA tester, CI job and
AI agent a fresh iOS simulator from a Mac mini in the office. One command turns the Mac into a
pool of simulators that people and programs lease, drive in the browser at 60 fps, and give
back. Every device is wiped before the next person gets it.

**Status: early. It runs on Macs with iOS simulators and Android emulators.** Nothing is published to npm yet, so
run it from a clone. The plan is in [ROADMAP.md](ROADMAP.md) and the design in
[docs/design.md](docs/design.md).

```bash
pnpm install
pnpm hangar up
```

Open the sign-in link it prints, invite your team from the People page, and they are using
simulators in the browser.

From a React Native app folder on any machine that can reach that Mac:

```bash
hangar login http://your-mac.local:7420
hangar run ios
```

That builds the Debug simulator app here (or takes `--app App.app`), starts Metro here if it is
not running, leases a simulator, installs and launches the app connected to your Metro, and
opens the live screen. Edit your code and Fast Refresh updates the leased device. Ctrl-C
releases it. [examples/hello](examples/hello) is a tiny app to try it with.

Guides: [your app on a leased simulator](docs/guides/expo.md),
[Maestro from GitHub Actions](docs/guides/github-actions.md),
[connecting an AI agent](docs/guides/agents.md), [recording a bug](docs/guides/recordings.md),
[more Macs and the broker in a container](docs/guides/more-macs.md),
[Android emulators](docs/guides/android.md), [device images](docs/guides/device-images.md).

## What works today

- `hangar up` on a Mac with Xcode and idb: checks the machine, keeps a warm pool of simulators
  sized from memory, and prints a one-use admin link. `hangar doctor` runs the checks alone.
- Leases with a fair queue, TTL, idle timeout and renew. Two clients never get the same device.
  A released device is deleted and replaced with a fresh clone, so nothing survives a lease.
- A REST API: screenshot, accessibility tree, batched actions (tap by element or point, swipe,
  type, key, button, wait for an element), install a `.app`, launch, terminate, open URL.
- A console: invite links and passwords, the device list, a live screen in H.264 at 60 frames
  per second (JPEG on plain-HTTP pages) with touch and keyboard, install and open URL.
- Teams with quotas, for operators on the People page: a team holds at most its quota of
  devices at once, and requests over it wait in the queue, fairly between teams.
- Single sign-on through any OpenID Connect provider, with groups mapped to teams and roles
  ([guide](docs/guides/sso.md)).
- MCP at `/mcp` for AI agents, with mobile-mcp's tool names, so agents written for it work
  unchanged. Each session gets its own lease ([guide](docs/guides/agents.md)).
- A TypeScript client (`hangar`) and a CLI: `login`, `lease`, `screenshot`, `ui`, `tap`,
  `type`, `install`, `launch`, `open-url`, `watch`, `release`.
- `hangar run ios`: your app on a leased simulator, loading JavaScript from the Metro on your own
  machine through Hangar, with Fast Refresh and React Native DevTools (console, breakpoints,
  network, components) through the same tunnel. Expo dev client builds open straight into the
  bundle.
- `hangar run maestro ./flows --app App.app --shards 3`: Maestro flows split over fresh devices,
  failed flows retried once, flaky flows marked, one merged JUnit report (`--junit`). Each retry
  is recorded, so a failed or flaky flow comes with a link to its video, timeline and app log.
  Hangar runs it (`POST /v1/runs`), so the console's Runs page shows it live and Ctrl-C or the
  page cancels it. A GitHub Action (`action.yml`) wraps the same command.
- Recordings with a bug link. Press Record in the console (or `hangar record`, `hangar lease
  --record`, the `record` MCP tool), test, and stop: the link opens the video, a timeline of
  every tap, swipe and key with failed ones marked, the app log and the last screenshot. Click a
  step or a log line and the video jumps there. The video is the stream's own H.264 written to
  an MP4 on the Mac, so recording costs no second encode. Recordings are kept for 14 days.
- Prometheus metrics at `/metrics`: devices, leases and hosts by state, time to get a device,
  how leases ended, device op timings, frames sent and dropped per codec. Counts and timings
  only, no names or ids, so it needs no token.
- Device presets from the API, CLI and MCP: simulated push, permissions, GPS location, light
  and dark mode, an app's language. The React Native dev menu and reload (command-D and
  command-R) from the console, CLI and MCP.

`hangar up --install` sets Hangar up as a LaunchAgent that starts at login and restarts if it
stops; with automatic login it comes back after a reboot. Its plist is tested, but the install
has not yet run end to end on a Mac mini.

More Macs join one broker with `hangar join`, and the broker runs alone in a container or on
Kubernetes ([guide](docs/guides/more-macs.md)).

Android emulators run next to the simulators with `hangar up --android <avd>`: a fresh read-only
instance per lease, the live screen, input, the tree, installs and Maestro
([guide](docs/guides/android.md)).

`hangar run xcuitest build/Build/Products` runs XCUITest from `build-for-testing` the same way
([guide](docs/guides/xcuitest.md)).

`hangar run espresso` does the same for Espresso on Android emulators.

Device images keep simulators ready with your app installed and a locale and appearance set:
`hangar image set norsk --app ./MyApp.app --locale nb_NO`, then `hangar lease --image norsk`
([guide](docs/guides/device-images.md)).

`hangar run android` builds, installs and runs your app on a leased emulator, connected to Metro
here.

Not yet: Android in Linux containers or on phones. Only one Hangar can run on a Mac at a time.

## Numbers

From `pnpm bench:stream` on an M4 Pro with Xcode 26.6 and an iPhone 17 simulator at 1206 by
2622, through the real broker and agent ([baseline](bench/stream.baseline.json)). The targets
are in [the design](docs/design.md#targets).

| | H.264 (HTTPS, localhost) | JPEG (plain-HTTP LAN) | Target |
|---|---|---|---|
| Frame rate during motion | 52 fps | 38 fps | 60 fps |
| Capture to client | 10.7 ms p50, 28.9 ms p95 | not measured | |
| Input to first changed frame | 109 ms p50, 197 ms p95 | 137 ms p50, 443 ms p95 | p95 under 80 ms |
| Bandwidth during motion | 509 KB/s | 1168 KB/s | |
| Fast Refresh, save to first frame on the leased device (`bench:metro`) | 87 ms p50, 163 ms p95 | | under 1 s |

Decoding in the browser adds about 2 ms (3 ms p95). The input p95 is not met, but most of it is
iOS, not Hangar: in a trace, the viewer's swipe reached the simulator's HID input in 1 to 7 ms,
and the rest went to iOS recognizing a scroll that starts on a table row. The JPEG fallback went
from 6 to 38 fps when screenshots started coming from the display (decision 0010). Comparisons
with other tools on the same hardware will be added here when they are measured.

Device calls on the same Mac, 10 calls each on a booted simulator, before and after they went
straight to the idb companion's gRPC (decision 0010):

| | Before | After |
|---|---|---|
| Element tree | 303 ms median | 3 to 5 ms median |
| PNG screenshot | 302 ms | 91 ms |
| JPEG screenshot, 800 px | 594 ms | 39 ms, from the display's IOSurface |
| Tap at a point | 4 ms | 2 to 10 ms |

## What it is for

- **Manual QA.** Pick a device in the browser, install a build, test it by touch, and file a bug
  with the recording attached.
- **Test suites.** Shard Maestro, XCUITest and Espresso suites across the fleet from CI and get
  JUnit back.
- **AI agents.** Lease a device over MCP or the REST API, read the screenshot and accessibility
  tree, tap by element, and release it.

## How it works

```
 browser, CI, agents ──HTTP(S)──> broker <──WebSocket── agent (Mac mini) ── simulators
                                                         agent (Mac)      ── emulators
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
  [security model](docs/design.md#7-security-model) and
  [what a leased app can reach](docs/guides/isolation.md).
- Not a new test framework. It runs the ones you already use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Hangar sends no telemetry and runs without internet access.
