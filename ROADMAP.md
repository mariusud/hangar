# Roadmap

The work is in streams that can run at the same time (see "Where Hangar is going"). The README and
docs describe only what has shipped.

## Goal

Hangar gives a React Native or Expo team one pool of fresh iOS simulators and Android emulators on
its own Macs, shared on a schedule by CI, by people in the browser and by the team's own AI agents.
The targets and their benchmarks are in [the design](docs/design.md#targets); a target counts as
met only when its benchmark runs on a real Mac mini and the README shows the number.

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

## Where Hangar is going

The target README is a scheduled pool of simulators and emulators on a team's own Macs. CI gets
devices on demand, people use them in the browser during the day, and at night a booking holds
devices for the nightly suite and the team's own QA agents. Every lease keeps the same record,
and a morning report collects what the night found. Hangar never ships an agent or calls a model.

The work is split into streams that can run at the same time, one agent or person per stream.
Each stream owns its files. Where two streams need the same file, the table says who owns it and
the other only adds entries to it (a route, a tool, a type), never changes existing code.

### Rules for parallel work

- Stream 0 goes first and alone. Everything else waits for it.
- Each stream works in its own git worktree and branch, touches only the files it owns, and ends
  with `pnpm typecheck` and `pnpm test` passing and a suggested commit message. Nobody commits
  for the maintainer.
- Shared files take additions only: `packages/protocol/src/index.ts` (new types), the route and
  tool registries from stream 0, and `docs/features.md` (one line per shipped feature).
- A change to the design gets a decision file first. Stream A writes decision 0012 (the schedule)
  before it writes code; it replaces decision 0011.
- Docs describe what exists. Stream H writes a guide only after the feature is merged.

### Stream 0: make room (one agent, first)

Split the files every stream would otherwise edit:

- `packages/broker/src/http.ts` (906 lines) into one route file per area under
  `packages/broker/src/routes/` (leases, runs, recordings, images, hosts, people), with one list
  that registers them.
- The MCP tools in `mcp.ts` and `mcp-mobile.ts` into `packages/broker/src/tools/`, one file per
  area, with one list that registers them.
- The golden-device code in `packages/agent/src/drivers/ios/index.ts` into `golden.ts`.

Done when the diff moves code without changing behaviour and every test passes.

Status: done. `http.ts` went from 906 lines to 58 and `mcp.ts` from 272 to 68, with no change in behaviour.

### Who owns what

| Stream | Owns |
|---|---|
| A. Leases and schedule | `broker/src/leases/`, `broker/src/schedule.ts` (new), `routes/leases.ts`, `routes/schedule.ts`, `tools/leases.ts`, `hangar/src/client/` lease and booking calls |
| B. Test runs | `broker/src/runs.ts`, `routes/runs.ts`, `hangar/src/run.ts`, `hangar/src/client/maestro.ts`, `action.yml`, `agent/src/xcuitest.ts` |
| C. Evidence and night reports | `broker/src/recordings.ts`, `broker/src/findings.ts` (new), `broker/src/reports.ts` (new), `routes/recordings.ts`, `routes/findings.ts`, `tools/findings.ts` |
| D. Device tools | `agent/src/drivers/` except `golden.ts`, `agent/src/tunnels.ts`, `agent/src/android.ts`, `tools/device.ts` |
| E. Device images | `broker/src/images.ts`, `routes/images.ts`, `agent/src/drivers/ios/golden.ts` |
| F. Host operations | `hangar/src/up.ts`, `hangar/src/service.ts`, doctor, `bench/`, `e2e/`, `agent/native/screen.swift`, `hosts/versions.json` (new) |
| G. Console | `packages/console/` |
| H. Docs and launch | `README.md`, `docs/`, `examples/`, `docs/assets/` |

### Wave 1: start together, after stream 0

**A1. Leases that last.** An idle timeout per token and role, capped by the operator (today it is
a fixed 5 minutes). A longest-lease cap, 8 hours by default. A keepalive MCP tool. Reattach by
lease id after a disconnect, with a grace period before the wipe. Done when an agent that
restarts mid-task gets its device back, in the property tests and on the office Mac mini.

Status: built and covered by property tests (token limits, keepalive, reattach with a 60 s grace, `hangar attach`). Not yet run on the office Mac mini. A dropped MCP connection is not detected, so an MCP client gets no grace period.

**B1. Better test runs.** Record the first failed attempt, not only the retry. Rerun one flow
(`POST /v1/runs/:id/flows/:flow/rerun`). One pull request comment from `action.yml` with passed,
flaky and failed flows and a video link for each failure, plus a nightly cron example. Flake rate
per flow and failures grouped by error, from the history `GET /v1/tests` already keeps.

Status: built and tested with fakes. The PR comment, the rerun and the nightly example have not run on a real GitHub runner. The first-attempt video covers the whole shard pass.

**D1. Device tools agents ask for.** The app log through `simctl spawn ... log stream` filtered to
the app, and `adb logcat` on Android. JavaScript evaluate and console through the Metro and Hermes
inspector the tunnel already carries. Network requests through the CDP Network domain on React
Native 0.83 and later, and a `fetch`/XHR patch before that. Two-finger HID for pinch and rotate if
the idb companion sends two contacts; check first. Orientation.

Status: app log, JavaScript evaluate and console, and network requests are built. The iOS app log ran on a real simulator; the JavaScript and network tools have not run against a real React Native app. Android rotation is built. Pinch and rotate gestures, and iOS rotation, answer `UNSUPPORTED`.

**E1. Images with a signed-in user.** `hangar image set --sign-in <file>` runs a sign-in Maestro
flow once on the golden device, with the account's secrets from the environment, never from the
repo. Permissions granted in the image with `simctl privacy`.

Status: built and tested with fakes. Secrets are stored in plain text in the broker's database, and a sign-in flow's subflows are not uploaded.

**F1. A Mac that runs alone.** A LaunchDaemon or a background `hangar` user, checked through a
real reboot with nobody logged in. `hangar doctor` fixes the idb companion when Homebrew refuses
it because the Command Line Tools are older than Xcode. A smoke test on each new Xcode (boot,
clone, capture, tree, tap, two Maestro flows, wipe) that writes `hosts/versions.json`, and a host
that won't schedule on an Xcode that hasn't passed. A fallback when the IOSurface capture breaks:
`idb video-stream`, then JPEG screenshots.

Status: the LaunchDaemon plist, the doctor check, `pnpm bench:smoke` and the opt-in version gate are built. The daemon hasn't been through a real reboot. `pnpm bench:smoke` passed on this laptop (Xcode 26.6, iOS 26.5) with its own `hangar-smoke-*` simulators; it is a pass or fail check, and its step times are diagnostics, not numbers for the docs. Recordings now work on the idb capture path too, through a small MP4 muxer, checked on a real simulator. A recording loses the part before a capture path switch. The capture fallback landed in wave 2: on one iOS 26.5 simulator the IOSurface path, the idb path and the switch between them produced H.264 that decoded cleanly.

**G1. Console wiring for what exists.** An image picker when leasing, buttons for locale, dark
mode and rotation (the presets exist in the API), and a view-only link to one lease or recording.

Status: the image picker, the appearance and locale buttons, and signed view-only links to recordings are built. A view-only link to a live lease is not.

**H1. Docs that can be written now.** `docs/licensing.md`, which links Apple's terms and claims
nothing. Remove the README line saying XCUITest and Espresso work the same way until B3 runs them
for real. Update `docs/comparison.md` so it makes no claims about other tools' security and uses
no "unique".

Status: done.

### Wave 2: needs wave 1

**A2. Held devices** (needs A1). A lease can end in a held state instead of a wipe, with its own
time limit that counts against the quota, and a person can take it over.

Status: built in the broker and the CLI (`hangar held <run> <flow>`), with property tests. The console stream and the Metro tunnel reach a held device. Tested against fake hosts only.

**A3. Bookings, priority and preemption** (needs A1 and decision 0012). A booking has a name, a
device count, days, a window and an image. CI keeps a floor that bookings can't
take. A lease from a lower priority gets a warning and ends two minutes later when a higher one
needs the device, with the reason recorded; an interrupted CI shard reruns. Property tests: an
agent that overruns its window never starves morning CI, and two bookings never hold one device.
`hangar book` and `hangar connect night`, which makes a token that works only inside a booking.

Status: bookings, the CI floor, priorities, preemption with a 2-minute notice (`lease_ending` on the event stream) and window ends with a 10-minute notice are built, with property tests for invariants 6 to 9. `hangar book`, `hangar bookings` and `hangar connect <booking>` work. Tested against a simulated fleet only. The "ci within 2 min 5 s" guarantee assumes a wipe of a few seconds, which hasn't been measured. Any member can make a ci-priority token.

**B2. Hold on failure** (needs A2). `hangar run maestro --hold 30m` keeps the failed shard's device,
and the pull request comment links to it.

Status: `--hold` keeps a failed shard's device, and an interrupted shard reruns its unfinished flows up to 3 times. The pull request comment doesn't link to the held device yet.

**C1. Findings and the morning report** (needs D1 for logs and network, A3 for the window end).
Every lease's record gains the app log and network requests. A `report_finding` MCP tool files a
title and description with the last two minutes of video, the taps, the log and a screenshot. A
night run groups a booking's leases and findings, and closes when the window closes. Hangar
makes no calls outside the network, so the team's scheduler posts the report:
`hangar night report <booking> --slack-webhook $URL` runs on the CI runner.

Status: findings, nights and the report (JSON and Markdown) are built, and a booking's window end closes its night. Tested against a fake host. No finding has been filed on a real simulator. A finding's video is a time span in the full recording, not a two-minute clip. A GitHub issue target is not built.

**G2. Console for wave 2.** The Schedule page, the held-device page with the flow's steps beside the
stream and a rerun button, flake rate on the Runs page, and a page per night with its findings.

Status: built. Rerun per flow, first-attempt links, a Flaky flows page, the lease's real limits and operator caps, the Schedule page (bookings, booking tokens, CI floors), Take the device and Release on held flows with the flow's steps beside the stream, a countdown banner on `lease_ending`, and the Nights and night pages with findings and Open again. Checked in a headless browser against a broker with a fake host. The console doesn't yet show image state, and the run page doesn't open a flow from the pull request's held-device link.

**E2. Image refresh.** Rebuild an image when a new app build lands, without ending active leases.

Wave 3 follow-up: image secrets are encrypted at rest (AES-256-GCM, key file next to the database, included in `hangar export`), `hangar image set --follow` refreshes an image when a build with the same name is uploaded, and hosts report each image as building, ready or failed, so a failed image refuses new leases with `IMAGE_FAILED`. `hangar images` shows the state. Tested with fakes only. Leases already waiting on an image that then fails keep waiting.

Status: `hangar image refresh <name> --app A` and `POST /v1/images/:name/refresh` build a new golden while leases on the old one keep running. Tested with a fake host only. A refresh doesn't start on its own when a build is uploaded, a failed build shows as pending, and Android has no images yet.

### Wave 3: proof and launch

**C2. Open again.** Replay a finding's taps on a fresh lease of the same image.

Status: `POST /v1/findings/:id/open-again` and the `open_again` MCP tool lease a fresh device like the finding's for the caller's team, record it, and replay the actions taken before the finding. Each step reports ok, skipped or failed, and whether it went by label or by coordinates. Tested against a fake host only. A tap replays by label only when the caller read the screen before tapping. Typed text is kept in plain text in the finding so it can be replayed.

**B3. XCUITest and Espresso for real**, against a real UI test target and a real test APK.

Status: XCUITest ran for real. `hangar run xcuitest` ran a small SwiftUI fixture (`e2e/fixtures/xcuitest`) on an iOS 26.5 simulator, and the JUnit showed a passing class and a failing test with its message. It ran against a test host, not a full agent with golden devices and wipes. Espresso hasn't run: this Mac has no Gradle cache or Espresso artifacts, and getting them is a download. `--booking` on runs and a held-device link in the pull request comment are built and tested with a fake host.

**F2. Numbers on a quiet Mac mini.** The office suite serially, then on 2 and 3 shards; flake rate
over 100 runs from the same golden device; lease, clone and wipe times. These need the office Mac
mini and the maintainer's go-ahead, since they are benchmark runs.

**H2. Launch.** `examples/night-qa` with a brief and an MCP settings file. Guides for Maestro,
night QA and device images. The README from `.agents/README-target.md` once everything in it
exists, with the measured numbers. A new header image and GIF. npm under Apache-2.0.

Status: the night QA and Maestro guides and `examples/night-qa` are written and checked against the code. The example hasn't run on a GitHub runner. The README swap waits for F2's numbers and for the release gates; the header, the GIF and npm wait for the maintainer.

### Using it for real

Alongside the streams, one office Mac mini moves its real work to Hangar, outside this repo:

- An assistant agent hosted in the cloud, which reaches the Mac over Tailscale and today uses
  another tool server, after A1 and D1.
- A nightly e2e suite on `hangar run maestro` with a device image of the app, after B1 and E1.
- Night QA with the team's own agent, after A3 and C1.

### Release gates

The first public release ships when these hold, each checked on a real Mac mini:

1. On a Mac with only Xcode installed, `npx hangar up` and the printed link get a teammate on
   another machine using a simulator in the browser in under 5 minutes, with no config file.
   Tested by someone who hasn't used Hangar before.
2. `bench/stream`: glass to glass p95 under 50 ms on a LAN, 60 fps, with 6 simulators streaming
   on one Mac mini; tap to first changed frame p95 under 80 ms.
3. `bench/lease`: lease from the warm pool to an interactive device, p95 under 2 s.
4. An AI agent leases, installs, takes a screenshot, reads the tree and taps by label over MCP,
   added with the one line the console shows.
5. Two clients asking for the last free device at the same moment: one gets it, the other is
   queued. The next lease of a released device finds no trace of the previous app, data or
   keychain.
6. The Mac reboots, and Hangar comes back with nobody logged in.
7. A night booking runs four agents and the nightly suite, ends on time, and posts its report;
   a pull request at 05:50 still gets a device.

### Later

- WebRTC for video and input, with TURN in the broker, once a measurement over the internet shows
  the WebSocket path is too slow. On one machine the transport is 20 ms of the 339 ms p95.
- A benchmark whose input changes the screen at once, so the input target measures Hangar rather
  than iOS (see the trace under "Hangar 2").
- The hardened level: the whole host inside one Tart macOS VM that joins with `hangar join`
  (decision 0010), measured in a guest first. Tart is being relicensed more permissively.
- The broker's Docker image in a real deployment with an agent joined, and a lint and install of
  the Helm chart.
- A second real Mac joined to a broker.
- A Homebrew formula, once a release exists.
- A public demo that resets itself.
- An agent-device provider plugin, so agent-device users can lease Hangar devices.
- Android emulators in Linux containers with KVM, Android phones over USB, Android images.
- Physical iPhones in the same pool and API.
- The Appium endpoint at `/wd/hub`.
- Postgres (decision 0009), and S3, OIDC and Postgres checked against real services.
- Bazel, through rules_react_native: a rule that uploads a built app to Hangar, and a
  `react_native_device_test` rule that runs Maestro flows with `hangar run`. Hangar never depends
  on Bazel.

## Not planned

- A hosted service, or features for reselling devices to third parties.
- Telemetry of any kind.
- An AI QA agent, exploration prompts, or triage of findings. Teams bring their own agent.
- A built-in cron. A booking holds devices; the team's own scheduler starts the agent.
- A test framework, flow format or flow recorder of Hangar's own. Maestro Studio records flows.
- Raw shell access to hosts through the API.
