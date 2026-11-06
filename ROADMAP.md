# Roadmap

Each milestone ends in a release, and the README and docs describe only what that release does.

## Goal

Hangar is the fastest way for React Native and Expo teams to give every developer, QA tester, CI
job and AI agent a fresh iOS simulator or Android emulator from a Mac mini in the office. The
targets and their benchmarks are in [the design](docs/design.md#targets); a target counts as met
only when its benchmark runs in CI on a real Mac mini and the README shows the number.

## Current status

Milestone 1 is partly built: `hangar up`, leases, the device API, the console, MCP, the client
and CLI work on one Mac, and the end-to-end test passes on real simulators. The console streams
native H.264 at 58 fps with 9 ms from capture to client, and input goes over gRPC (decision
0007, `pnpm bench:stream`). Input to first frame is 86 ms p50 and 339 ms p95, so that target is
not met yet.

Milestone 2 has started: `hangar run ios` builds or takes the app, leases a simulator, and
loads JavaScript from the developer's own Metro through a tunnel in the broker. Fast Refresh
shows an edit on the leased device within 503 ms (measured by hand; `bench/metro` is not
written yet). The example app is `examples/hello`.

Also done in milestone 2: device presets (push, permissions, location, appearance, an app's
language) and the dev menu and reload, over the API, CLI and MCP; `hangar run maestro`, which
leases one fresh device per shard, retries failed flows once, marks flaky ones and merges JUnit.
The run is coordinated by the client for now; the broker's runs API, the runs page, per-test
video and the GitHub Action are still to do. The leased app shows up as a React Native DevTools
target on the developer's Metro, but a full DevTools session through the tunnel is not checked
yet.

Spike results: idb's tree and taps work on Xcode 26.6 and iOS 26.5 when Hangar runs its own idb
companion per device. A clone of a booted-once golden device boots in about 4 s, against 21 s
after `simctl erase`, so the wipe is delete and re-clone. Running without a logged-in user is
still untested. macOS VMs lose the hardware video encoder and are capped at two per Mac, so
sandboxing starts with a separate macOS user, not a VM.

## Milestone 1: one Mac, iOS simulators, fast

`hangar up` and `hangar doctor`, the broker and agent in one process on SQLite, leases with the
fair queue and wipe on release, the device API, MCP, the TypeScript SDK and CLI, built-in
accounts with invite links, the console with the native H.264 stream and touch input,
recordings, Prometheus metrics, and the benchmark suite.

Done when:

1. On a Mac with only Xcode installed, `npx hangar up` and opening the printed link get a
   teammate on another machine driving a simulator in the browser, in under 5 minutes, with no
   config file. Tested by someone who has not used Hangar before.
2. `bench/stream`: glass to glass p95 under 50 ms on a LAN, 60 fps, with 6 simulators streaming
   on one Mac mini; tap to first changed frame p95 under 80 ms.
3. `bench/lease`: lease from the warm pool to an interactive device, p95 under 2 s.
4. An AI agent does lease, install, screenshot, tree, tap by label over MCP, added with the one
   line the console shows.
5. A tester leases a simulator in the console, uses it by touch, and gets a bug link with the
   recording.
6. Two clients asking for the last free device at the same moment: one gets it, the other is
   queued. The next lease of a released device finds no trace of the previous app, data or
   keychain. Both checked in the end-to-end suite.
7. The Mac reboots, and Hangar is back with nobody logged in, or with auto-login set up by
   `hangar up` if that fails.

## Milestone 2: the React Native workflow

- `npx hangar run ios`: build locally or take an EAS or Bazel artifact, install on a leased
  simulator, connect the app to the developer's own Metro through the broker. `bench/metro`:
  Fast Refresh on the remote simulator under 1 s.
- The dev menu, deep links, simulated push, permissions, locale and location presets as API
  calls and MCP tools.
- React DevTools, the Hermes debugger and the network inspector through the lease.
- Maestro runs sharded over devices, with retries, merged JUnit and per-test video, the runs page
  in the console, a GitHub Action. `bench/shard`: 200 tests over 6 simulators, 5 times faster
  than on one.
- Docs: an Expo quickstart, a GitHub Actions recipe, an agent recipe for Claude Code and Cursor.

## Milestone 3: Android, more hosts

- Android emulators on Mac and in Linux containers with KVM, Android phones over USB.
- `hangar join` for more Macs and Linux boxes, placed by class, capacity and team.
- The broker as a container image, `hangar export` and `hangar import`, the Helm chart.
- XCUITest and Espresso runs, the Appium endpoint at `/wd/hub`.
- OIDC, teams and quotas, Postgres, S3-compatible artifact storage.
- The agent as its own macOS user, and an optional Tart VM image users build themselves.

## Milestone 4: device images and iPhones

- Device images: a declared state (OS runtime, app build, signed-in test account, permissions,
  locale) built once, stored by content hash, copied to every host.
- Physical iPhones in the same pool and API.
- Booking a phone for a time window.

## Integrations outside this repo

- Bazel, through rules_react_native: a rule that uploads a built `.app` or `.apk` to Hangar, and a
  `react_native_device_test` rule that runs Maestro flows on the fleet with `hangar run`, so Bazel
  caches device test results by the app's and flows' content. Hangar itself never depends on
  Bazel.

## Not planned

- A hosted service, or features for reselling devices to third parties.
- Telemetry of any kind.
- A test framework or flow format of Hangar's own.
- Raw shell access to hosts through the API.
