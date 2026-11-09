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
native H.264 at 52 fps with 11 ms from capture to client, and input goes over gRPC (decision
0007, `pnpm bench:stream`, 2026-11-07). Input to first frame is 109 ms p50 and 197 ms p95, so
that target is not met; most of it is iOS (Hangar 2 below).

Recordings are built (milestone 1, item 5): the console's Record button, `hangar record`,
`lease --record` and the `record` MCP tool save the video (the stream's own H.264 in an MP4,
written by the screen helper with no second encode), a timeline of actions with failures
marked, the app log and the last screenshot, behind one link for the bug report. Prometheus
metrics are at `/metrics`.

`bench/lease` measures a warm lease: the lease is active in 10 ms, and the pool now reads the
tree and takes a screenshot once before it calls a device ready, which cut the first tree read
from 6.7 s to 2.5 s. Those numbers are from a Mac running under heavy unrelated load (a load
average over 100); the 2 s target needs a clean run on a Mac mini before it counts.

Milestone 2 has started: `hangar run ios` builds or takes the app, leases a simulator, and
loads JavaScript from the developer's own Metro through a tunnel in the broker. Fast Refresh
shows an edit on the leased device 87 ms p50 and 163 ms p95 after the file is saved
(`pnpm bench:metro`). The example app is `examples/hello`.

Also done in milestone 2: device presets (push, permissions, location, appearance, an app's
language) and the dev menu and reload, over the API, CLI and MCP; `hangar run maestro`, which
leases one fresh device per shard, retries failed flows once, marks flaky ones and merges JUnit.
Each retried flow runs recorded, so failed and flaky flows have a video link in the output and
in the JUnit report. The broker coordinates the run (`/v1/runs`), the console's Runs page shows
it live and can cancel it, and `action.yml` is the GitHub Action, which also writes the job
summary. `bench/shard` is still to do.

React Native DevTools works through the lease: the frontend on the developer's Metro connects to
the app on the leased simulator through the tunnel (console, breakpoints, network), and a
console evaluate takes 5 ms p50 and 8 ms p95 there and back. `hangar run ios` prints the link.
It has to use 127.0.0.1, because Expo's dev server closes debugger sockets whose Origin is not
exactly its own address.

`bench/compare` runs the stream test (input to first frame, frame rate and bandwidth while a list
scrolls) against Hangar, serve-sim and Simlock on the same Mac with the same simulator model, and
times a warm lease on Hangar and Simlock. It downloads nothing; the other tools are installed by
hand and named with `SERVE_SIM` and `SIMLOCK`. It has run end to end, but only under heavy
unrelated load, so it has no numbers to publish yet.

Milestone 3 has started. `hangar join <url> --token` connects another Mac's agent to a broker
over one WebSocket (decision 0008), and it reconnects on its own. `hangar broker` runs the broker
without devices, `Dockerfile` builds it as an image, and `deploy/helm/hangar` runs it on
Kubernetes. `hangar export` and `hangar import` move a broker's database, builds and recordings.
The socket and export/import are tested on one Mac only. No second Mac has joined yet. The image builds and
runs; the Helm chart has not been linted or installed.

Android emulators on a Mac work: `hangar up --android <avd>` (or `hangar join ... --android`)
runs read-only instances of one AVD, so a lease's wipe is killing the instance. The live screen
is H.264 from `screenrecord`, and the tree, input, installs, Maestro and the Metro tunnel work;
checked by leasing and driving a real emulator through the broker and the console. Not done:
emulators in Linux containers, phones over USB, a JPEG stream, and push, permissions, language
and recordings on Android. `hangar run android` builds with Gradle, starts Metro, leases an
emulator, installs and launches; only its errors were checked here, because this Mac has no
Gradle cache and no Android build of the example app.

XCUITest runs: `hangar run xcuitest <Build/Products>` uploads the products of
`build-for-testing`, and the broker shards targets or classes over leases like Maestro flows,
with the same retries, recordings and JUnit. The agent runs `xcodebuild test-without-building`
on the leased simulator and reads results from its output. Tested against a fake agent and with
recorded xcodebuild output; not yet run against a real UI test target.

Espresso runs: `hangar run espresso --app <apk> --test-apk <apk>` installs both on a fresh
emulator per shard and runs `am instrument`, sharded by class with the same retries and JUnit.
Tested against a fake agent and with recorded instrumentation output; not yet run against a real
test APK. The Appium endpoint is still to do.

Teams and quotas: operators make teams, set each one's quota and move people between them, on
the People page or at `/v1/teams`. Leases count against the holder's team, and the scheduler
(already fair between teams) keeps a team at its quota by queueing, not refusing. One-team
setups see no team column. Runs and recordings are visible to their team and to operators; to
anyone else they look like they do not exist. There is no team-admin role yet.

OIDC sign-in: the authorization code flow with PKCE against the issuer in
`HANGAR_OIDC_ISSUER`, with the ID token checked against the provider's keys, and groups mapped
to teams and the operator role (`HANGAR_OIDC_GROUPS`). Tested end to end against a fake
provider in the broker tests; not yet against a real one.

S3-compatible storage for builds and recordings (`HANGAR_S3_*`): files land on disk, then go to
the bucket, and reads go through the broker. The request signing matches AWS's published
example, and the store is tested against a fake bucket; not yet against AWS or MinIO.

Postgres is deferred (decision 0009): the broker keeps SQLite until it can run as more than one
process, because a second broker on the same database would schedule the same devices twice.

`hangar up --install` writes a LaunchAgent (start at login, restart on exit) and points to
automatic login for unattended reboots; `--url` sets the address Hangar gives out, such as a
Tailscale HTTPS name. Not yet run end to end on the office Mac mini. A LaunchDaemon with nobody
logged in is still untested.

Spike results: idb's tree and taps work on Xcode 26.6 and iOS 26.5 when Hangar runs its own idb
companion per device. A clone of a booted-once golden device boots in about 4 s, against 21 s
after `simctl erase`, so the wipe is delete and re-clone. Running without a logged-in user is
still untested. macOS VMs lose the hardware video encoder and are capped at two per Mac, so
sandboxing starts with a separate macOS user, not a VM.

## Hangar 2 (decision 0010)

Done:

- Device calls go straight to the idb companion's gRPC, and JPEG screenshots come from the
  simulator's display through a long-lived process in the Swift helper: the element tree went
  from 303 ms to 3 to 5 ms, a JPEG screenshot from 594 ms to 39 ms (docs/numbers.md).
- Five packages instead of eight: the drivers are in the agent, and the CLI and client are one
  package, `hangar`.
- mobile-mcp's tool names on the MCP endpoint, a device being a lease
  ([guide](docs/guides/agents.md)).
- `hangar doctor` says which user Hangar runs as, and a guide sets up a `hangar` user
  ([guide](docs/guides/isolation.md)). A separate simulator device set was dropped: Maestro and
  `xcodebuild` only find devices in the user's default set.
- Shards are balanced by each test's last timing, longest first.
- A device image's golden device is named after the runtime too, so an Xcode update rebuilds it.
- `GET /v1/tests` and `hangar tests`: passes, flaky passes and failures per test.
- The console's Fleet page: every device with a live picture, its holder, how it was leased and
  what was last done on it. A real Claude agent leased a device over MCP and worked it while the
  page showed it. A Maestro run and a scripted tester at the same time timed out on the install
  step, twice, on a Mac with a load average over 600; that still needs a run on a quiet Mac.
- `hangar connect claude | cursor | ci` makes a token for the target and adds it (Claude Code)
  or prints exactly what to paste. `hangar up` signs in the CLI on its own Mac as the admin.
- Fixes found on the way: action points outside the screen are refused instead of swiping
  off-screen for 31 s, and companions left by a Hangar that was killed hard are stopped when
  the next one starts.

To do:

- The input benchmark measures iOS, not Hangar. A trace of 8 swipes through the real stack
  (2026-11-07): the viewer's input reaches the HID call in 1 to 7 ms (20 ms on the first), and
  the first changed frame comes 56 to 112 ms later (382 ms on the first after Settings launches).
  The same swipe straight on the driver, mid-list, shows its first frame in 18 ms p50, 74 ms p95.
  The time goes to iOS recognizing a scroll that starts on a table row. Still to do: a benchmark
  whose input changes the screen at once, so the target measures Hangar.
- WebRTC for video and input, with TURN in the broker, once a WAN measurement shows the WebSocket
  path is too slow. On one machine the transport is 20 ms of the 339 ms p95.
- The hardened level: the whole host inside one Tart macOS VM that joins with `hangar join`
  (decision 0010). First measure, in a guest: simulator boot and frame rate, whether H.264
  encoding is hardware or software and its CPU per stream, clone and boot time, idle memory.
  Needs a macOS VM image with Xcode, tens of GB to download. Tart's license needs a reading.
- A Homebrew formula, which needs a published release to point at.
- The broker's Docker image in a real deployment with an agent joined to it. It builds (411 MB)
  and starts, serves the console and keeps its data volume across restarts (2026-11-08).
- A public demo that resets itself.
- Not checked: simulators booting for a `hangar` user that is logged in in the background.

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
  locale) built once, stored by content hash, copied to every host. Started: an operator declares
  an image (apps, locale, appearance) with `PUT /v1/images/:name` or `hangar image set`, each iOS
  host builds it once as its own golden device and keeps clones warm, and `class.image` leases
  one ([guide](docs/guides/device-images.md)). On this Mac a lease asked for right after the
  declaration queued, the image built in about 40 s, and the lease was active at 44 s on a clone
  with the declared locale and appearance. Not yet: Android images,
  signed-in accounts, permissions.
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
