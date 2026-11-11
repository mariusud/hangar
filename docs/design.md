# Hangar design

Status: draft, 2026-11-05. Milestone 1 is partly built; ROADMAP.md says what runs today.

Hangar is an open-source (Apache-2.0) device fleet that a software team runs on its own hardware.
It is built first for React Native and Expo teams: the fastest way to give every developer, QA
tester, CI job and AI agent a fresh iOS simulator or Android emulator from a Mac mini in the
office. One command on the Mac turns it into a pool of devices. People and programs on the team
lease devices from that pool and give them back. Each device is wiped before anyone else gets it. When one Mac is
not enough, more Macs, Linux boxes and USB phones join the same pool with one command each.

It is software you run, not a hosted service, and it has no paid tier. "Hangar" is a working
name.

This document is the design for review. User docs will live in `docs/` next to it, decisions in
`docs/decisions/`, and the plan in `ROADMAP.md`.

## Easy to use comes first

The tools in section 2 can each do part of this job. What none of them is, yet, is something a
team sets up in an afternoon without reading a manual. That is Hangar's main goal, and it wins
when it conflicts with features: a feature that needs a config file, an extra service or a
networking change before it works is either given a default that works, or waits.

### The first ten minutes

On a Mac with Xcode installed:

```bash
npx hangar up
```

That command checks the machine (Xcode, runtimes, disk, memory, the tools Hangar needs), installs
the pinned tools it is missing, starts the broker and the agent in one process, creates a device
class for each installed simulator runtime, sizes the pool from the Mac's memory, installs itself
as a service so it survives a reboot, and prints:

```
Hangar is running at http://studio-mini.local:7420

  Sign in as admin:   http://studio-mini.local:7420/welcome/7KQ2-XM4P   (one use, 30 min)
  Add another Mac:    npx hangar join http://studio-mini.local:7420/join/hgr_join_...
  Connect an agent:   claude mcp add --transport http hangar http://studio-mini.local:7420/mcp
```

The admin opens the link, gets a session in the console, and invites teammates by copying invite
links. A teammate opens the link, picks a simulator, and is using it in the browser. Nobody wrote
a config file, set up a database, opened a port or configured TLS.

### Targets

Each target is a benchmark in the repo, run on a real Mac mini in CI, and the README shows the
latest numbers. A target without a benchmark is not met.

| Target | Goal | Benchmark |
|---|---|---|
| New user: Mac with Xcode to a teammate driving a simulator in the browser | under 5 min | usability test, `bench/setup` |
| Lease from the warm pool to an interactive device | p95 under 2 s | `bench/lease` |
| Live view, glass to glass on a LAN | p95 under 50 ms, 60 fps, 6 streams per Mac mini | `bench/stream` |
| Tap to the first changed frame | p95 under 80 ms | `bench/stream` |
| A developer's own Metro drives the remote simulator | Fast Refresh under 1 s | `bench/metro` |
| A 200-test Maestro suite sharded over 6 simulators | 5 times faster than on one | `bench/shard` |
| Wipe between leases | no app, data or keychain survives | e2e suite |

The other first-use targets:

- Adding a host: one command, pasted from the console. No token copying by hand.
- Connecting an AI agent: one `mcp add` line, shown in the console with the token filled in.
- A CI suite: one command (`npx hangar run maestro ./flows --build app.zip`) and one secret.

### React Native first

The features an RN developer notices on the first day come before broad platform coverage:

- `npx hangar run ios` works like `expo run:ios`. It builds locally or takes an EAS or Bazel
  artifact, installs it on a leased simulator, and connects the app to the Metro server on the
  developer's laptop through the broker, so Fast Refresh works on the remote device.

  The connection is a tunnel. The agent listens on a free port on its Mac's loopback, where the
  leased simulator reaches it as `localhost:<port>`. Each connection the app opens there goes
  over the agent's WebSocket to the broker, then over the CLI's WebSocket
  (`/v1/leases/:id/tunnel`, lease holder only) to the CLI, which connects it to Metro on
  `127.0.0.1:8081`. The app finds the port through `RCT_jsLocation` in its user defaults
  (`POST /v1/leases/:id/metro`), or, for an Expo dev client, through its
  `exp+<slug>://expo-development-client/?url=` deep link. Metro's HTTP, WebSocket (Fast
  Refresh) and debugger traffic all use the same tunnel.
- The dev menu, deep links, simulated push notifications, permissions, locale and location
  presets are one API call and one MCP tool each.
- React DevTools, the Hermes debugger and the network inspector work through the lease.

### Rules that follow from it

- **One process for one Mac.** `hangar up` runs the broker and the agent together, with SQLite
  and artifacts on local disk. The container, Postgres and S3-compatible storage are for when a
  team outgrows one machine, and moving there is `hangar export` on the Mac and `hangar import` in
  the container.
- **No config file by default.** Every setting has a default derived from the machine or the
  team. Settings live in the console and in `hangar config`; a file is optional, for people who
  want it in git.
- **Built-in accounts.** Invite links and passkeys or passwords work with no identity provider.
  OIDC is one setting away for teams that have one, not a requirement.
- **The stream works on any network.** WebRTC when the viewer can reach the host, and an automatic
  fallback over the broker's own connection when it cannot, so nobody has to run a TURN server to
  watch a device from home or through an ingress.
- **Doctor before failure.** `hangar doctor` runs the checks `hangar up` runs, explains each
  problem in a sentence, and fixes the ones it can. A host that fails a check says so in the
  console instead of failing leases.
- **Errors say what to do.** Every error has a code, a sentence, and the next step: "No iPhone 17
  on iOS 26.1 is free. 3 requests are ahead of you, expect about 2 minutes. Use `--wait` to queue,
  or pick another model."
- **Links for everything.** A lease, a device stream, a run and a recording each have a URL that
  can be pasted into a chat or a bug.
- **Names people use.** Device classes accept "iPhone 17", "ios 26", "pixel 9"; the CLI and MCP
  match loosely and say what they picked.

## 1. Who uses it

| User | What they do | What they need from Hangar |
|---|---|---|
| QA tester | Picks a device in the browser, installs a build, tests by hand, files a bug. | An interactive console with touch input, screenshots and a recording to attach to the bug. |
| CI pipeline | Runs the Maestro or XCUITest suite on every pull request. | Shard a suite over N devices, retry flaky tests, return JUnit and artifacts, exit non-zero on failure. |
| Existing Appium suite | Points its driver at a remote server. | An Appium-compatible endpoint backed by leases. |
| AI agent | A support or coding agent, often in Kubernetes or on a laptop. | MCP and a typed API: screenshot, accessibility tree, tap by element. |
| Developer | Runs a branch on a phone they don't own. | CLI lease, install, open the stream. |
| Operator | Runs the Macs. | Teams, quotas, capacity, health, upgrades, an audit log. |

Milestone 1 serves agents and manual QA first, because they need the least: a lease, the device
API and the console. CI suites and Appium follow in milestone 2.

## 2. What already exists

Checked against each project's docs, and its source where available, on 2026-11-05.

| Tool | Self-hosted | iOS sims | Android | Phones | Interactive console | Suite sharding | Teams and SSO | License |
|---|---|---|---|---|---|---|---|---|
| Simlock 0.5 | Yes | Yes | Yes | Yes | No, read-only | Not found | Token roles, sign-in proxy | MIT |
| GADS 6.1 | Yes | No | Emulators | Yes | Yes | Through its Appium grid | Workspaces, JWT issuers | AGPLv3, UI proprietary |
| tapflow | Yes | Yes | Yes | No | Yes | Its own YAML flows, `--parallel` up to 16 devices | Roles and invites, no SSO | MIT |
| baguette | Yes | Yes | No | No | Yes | No | No | Apache-2.0 |
| DeviceFarmer STF | Yes | Experimental | Yes | Yes | Yes | No | Groups | Apache-2.0 (not rechecked) |
| Argent Cloud, Limrun, Revyl, Expo Simulators | No | Yes | Some | No | Yes | Some | Yes | Hosted |
| BrowserStack, Sauce Labs, AWS Device Farm | No | Some | Yes | Yes | Yes | Yes | Yes | Hosted |
| Corellium | On-prem appliance | Virtual iPhones | Yes | No | Yes | No | Yes | Commercial |

Notes from reading them:

- **Simlock** is the most complete open option and the closest in spirit: TypeScript on Node 22, a
  gateway for several workers, a warm pool, baselines, RAM-aware admission, MCP, enrolled phones.
  Its console "only shows things: you cannot lease, release or fix anything from it". People sign
  in through a sign-in proxy such as Cloudflare Access, not OIDC. Its docs say to "treat an agent
  token like shell access to your workers", because `exec`, `simctl` and `adb` passthrough are
  features. The accessibility tree comes from Callstack's agent-device, which Simlock proxies.
- **tapflow** calls itself "a self-hosted Appetize / BrowserStack alternative for mobile QA
  teams", and it is the closest for manual QA: a browser QA session, build distribution from CI,
  roles (Admin, Developer, QA, Viewer), several Macs behind one relay, MCP, and experimental flow
  runs. It has no leases or queue, a full reset between sessions is opt-in, sign-in is password
  and invite, it runs its own flow format rather than Maestro, XCUITest or Appium, and it has no
  physical phones. Its stream is H.264 over WebSocket, decoded with WebCodecs.
- **GADS** is the closest for Appium suites on real phones: an interactive UI, an Appium grid with
  a queue, workspaces that segment devices and users. It has no iOS simulators, needs MongoDB, is
  AGPL, and its hub UI ships only as an obfuscated proprietary binary. Its Selenium Grid
  prerequisite is stale; the hub embeds its own grid.
- **Argent**'s `simulator-server` is proprietary and "licensed solely for use within this project",
  so it cannot be reused. Its Apache-2.0 tool-server is a good reference for the agent tool surface.
- **Firebase Test Lab** shuts down on 2027-09-30, so some teams are looking for a replacement now.

### Why a separate project

Hangar needs things none of these combine: iOS simulators and phones in one pool, leases with a
fair queue and a wipe on every release, the standard suite runners (Maestro, XCUITest, Appium),
OIDC, and isolation the host enforces rather than asks for. Simlock has the leases but treats
`exec` passthrough as a feature and keeps its console read-only by design. tapflow has the QA
console but is built around sessions and its own flow format. Changing either would mean
changing what the project is for, so an upstream contribution is unlikely to land.

Hangar borrows where the license allows, with notices kept: Simlock's lease semantics and capacity
rules (MIT), the scrcpy server (Apache-2.0), serve-sim's capture path (Apache-2.0). Ideas taken
from the others: Limrun's split of org, instance and stream tokens and its pair of idle and hard
timeouts; Argent's normalized element frames and batched actions; tapflow's agent that connects
out so hosts need no inbound ports, and its Mac picker that shows CPU and RAM headroom; GADS's
Appium endpoint with a queue in front of it.

## 3. Architecture

```
  Browser (QA)   CI / Appium     AI agents         CLI
      |              |                |              |
      |   HTTPS: REST /v1, Appium /wd/hub, MCP /mcp, WHEP signaling, OIDC
      v              v                v              v
  +--------------------------------------------------------+
  | Broker (Linux container)                               |
  |  API, console, scheduler, run coordinator, OIDC        |
  |  SQLite or Postgres, artifact store (disk or S3 API)   |
  +--------------------------------------------------------+
               ^  one outbound WSS connection per host
               |
  +--------------------------------------------------------+         WebRTC media
  | Host agent (Mac mini or Linux, launchd or systemd)     |-------> to viewers (UDP)
  |  lease table, op allowlist, warm pool, runners         |
  |  drivers: simctl, idb, adb, emulator gRPC, scrcpy, WDA |
  +--------------------------------------------------------+
               |  local only
     simulators, emulators, USB phones
```

All control goes client to broker, broker to host over the host's WebSocket, host to device.
Clients never learn a device id and never reach a host directly. The exception is WebRTC media,
which flows from the host to the viewer because relaying video through the broker costs bandwidth
and latency without making anything safer. The host only sends media to a peer that completed
signaling through the broker with a valid token.

On one Mac, `hangar up` runs the broker and the agent in the same process, connected in memory
instead of over a WebSocket. The code is the same; only the transport differs. A team moves the
broker into a container when it adds hosts on other networks or wants it on Kubernetes. Hosts
on the same LAN can join a broker that still runs on the first Mac.

### Broker

- One Node 22 process: inside `hangar up` on a Mac, or alone in a container on Kubernetes or
  Docker.
- Serves the REST API, the Appium endpoint, MCP, the console, OIDC sign-in and WHEP signaling.
- State in SQLite by default, Postgres through a connection string. One broker instance at a time.
- Artifacts (builds, test bundles, recordings, screenshots, logs) on a local volume, or any
  S3-compatible store such as MinIO. Retention is set per team.
- In a container, TLS comes from the ingress. On a Mac, `hangar up` serves plain HTTP on the LAN
  by default, and the console shows a banner saying tokens travel unencrypted until TLS is set up
  (`hangar config tls --cert --key`, or a reverse proxy). This trades transport security for a
  setup with no certificate, and the docs say so on the setup page.
- No outbound calls except to the OIDC issuer and the artifact store, when those are configured.

### Host agent

- One Node 22 process per machine, running as a dedicated non-admin user `hangar`.
- Connects out to the broker, reconnects with backoff, opens no listening TCP port.
- Creates, boots, wipes and deletes devices, keeps the warm pool the broker asks for, and reports
  health, capacity, memory pressure, versions and inventory.
- Runs test runners (Maestro, `xcodebuild test-without-building`) against leased devices.
- Keeps its own lease table and refuses any op for a lease it does not hold (section 6).
- A LaunchDaemon with `UserName=hangar` on macOS, a systemd unit on Linux. `hangar up` and
  `hangar join` create the user and install the service, asking for the admin password once;
  `hangar uninstall` removes both.
- Installs the pinned versions of the tools it drives (idb companion, scrcpy server, Appium and
  its drivers, Maestro) into its own folder on first start, and from an offline bundle on
  machines without internet access. Xcode and the Android SDK are the only things the team
  installs itself.

Spike before anything else is built on it: can CoreSimulator boot devices, and can idb and
`xcodebuild` drive them, from a LaunchDaemon with no console session? Simlock gave up on this and
requires auto-login. If the spike fails, Hangar documents auto-login of the `hangar` user.

## 4. Concepts

- **Team.** Owns tokens, leases, runs, builds and quotas. People join teams through OIDC groups.
  Every installation starts with one team, so small setups never see the concept.
- **Device class.** A selector: `platform` (`ios-simulator`, `android-emulator`, `ios-device`,
  `android-device`), `model`, `os`, and optional `build`. Fields left out mean "any".
- **Device.** A simulator, emulator or phone on a host. Simulators and emulators are created and
  deleted by Hangar. Phones are enrolled by an operator and can be assigned to teams.
- **Build.** An app artifact (`.app` zip, `.ipa`, `.apk`) stored by SHA-256 with a name and version,
  uploaded by CI or a person with the scope for it.
- **Lease.** Exclusive use of one device by one principal for a bounded time.
- **Run.** A test suite executed over one or more leases, with results and artifacts.
- **Recording.** Video plus the action log and tree snapshots of a lease, kept when asked for.

## 5. API

REST and JSON under `/v1`. Every request carries `Authorization: Bearer <token>` or the console's
session cookie. Errors have one shape: `{ "error": { "code": "LEASE_NOT_ACTIVE", "message": "..." } }`.

### Leases

| Method and path | What it does |
|---|---|
| `POST /v1/leases` | Request a lease. Body: `class`, `ttlSeconds`, `maxSeconds`, `labels`, `record`, `idempotencyKey`. `?wait=120` blocks up to 120 s for `active`. |
| `GET /v1/leases/:id` | State, deadline, queue position, device info (model, OS, screen size, never a host id or UDID). |
| `GET /v1/leases/:id/events` | Server-sent events: `queued`, `preparing`, `active`, `renewed`, `ended` with a reason. |
| `POST /v1/leases/:id/renew` | Push the deadline to now plus `ttlSeconds`, capped by `maxSeconds`. |
| `DELETE /v1/leases/:id` | Release. Returns at once; the wipe happens after. |
| `GET /v1/leases` | Your leases; your team's for team admins; all for operators. |

Defaults: `ttlSeconds` 600, `maxSeconds` 14400, idle timeout 300 s without a device op or renew.
Operators change defaults and caps per team.

### Device operations

Under `/v1/leases/:id/`. The lease must be `active` and owned by the caller, or the caller is an
operator.

| Method and path | What it does |
|---|---|
| `GET screenshot` | PNG, or `?format=jpeg&quality=70&scale=0.5`. |
| `GET ui` | Accessibility tree: `role`, `label`, `value`, `identifier`, `enabled`, a frame in points and the same frame normalized to 0 to 1. `?screenshot=1` adds a JPEG. |
| `POST actions` | Batched input, run in order. With `"observe": true`, returns a screenshot and tree after the last step. |
| `POST apps` | Install `{ "build": "myapp@1.4.0" }`, or a multipart upload with the `install:upload` scope. |
| `POST apps/:bundleId/launch` | Launch with optional `args` and `env`. |
| `POST apps/:bundleId/terminate` | Terminate. |
| `DELETE apps/:bundleId` | Uninstall. |
| `POST open-url` | Open a URL or deep link. |
| `POST settings` | Locale, appearance, location, permissions (`simctl privacy`), status bar. |
| `GET logs` | Server-sent events of device log lines, `?process=MyApp&level=info`. |
| `POST stream` | WHEP: SDP offer in, SDP answer out. The session has a data channel for touch input. |
| `POST stream-token` | Mint a stream token for this lease, to embed the stream elsewhere. |

Actions:

```json
{
  "actions": [
    { "type": "tap", "element": { "label": "Sign in", "role": "button" } },
    { "type": "type", "text": "tester@example.com" },
    { "type": "key", "key": "return" },
    { "type": "swipe", "from": [0.5, 0.8], "to": [0.5, 0.2], "durationMs": 300 },
    { "type": "waitFor", "element": { "identifier": "home-screen" }, "timeoutMs": 5000 },
    { "type": "tap", "point": [0.5, 0.9] }
  ],
  "observe": true
}
```

`tap` takes a normalized point or an element selector. The host resolves a selector against a
fresh tree and fails with `ELEMENT_NOT_FOUND` or `ELEMENT_AMBIGUOUS`, or taps the centre of the
frame. `identifier` matches exactly; `label` matches case-insensitively as a substring unless
`"exact": true`. Other types: `longPress`, `button` (home, lock, volume), `waitFor` with
`"gone": true`.

### Runs

| Method and path | What it does |
|---|---|
| `POST /v1/runs` | Start a run. Body: `build`, `suite`, `class`, `shards`, `retries`, `record` (`never`, `on-failure`, `always`). |
| `GET /v1/runs` | The team's recent runs. |
| `GET /v1/runs/:id` | State, per-shard progress, pass and fail counts. |
| `GET /v1/runs/:id/events` | Server-sent events per test. |
| `GET /v1/runs/:id/junit.xml` | Merged JUnit report. |
| `GET /v1/runs/:id/artifacts` | Per-test video, screenshots, logs, and runner output. |
| `DELETE /v1/runs/:id` | Cancel; releases its leases. |

```json
{
  "build": "myapp@1.4.0",
  "suite": { "kind": "maestro", "artifact": "sha256:...", "include": ["flows/**/*.yaml"] },
  "class": { "platform": "ios-simulator", "model": "iPhone 17", "os": "26.1" },
  "shards": 4,
  "retries": 1,
  "record": "on-failure"
}
```

Suite kinds:

- `maestro`: a zip of flow files. The host runs the Maestro CLI against the leased device. Shards
  split by flow file.
- `xcuitest`: the `.xctestrun` and test bundle from `build-for-testing`. The host runs
  `xcodebuild test-without-building` with `-destination id=<udid>` and `-only-testing` per shard.
  Shards split by test class. Uploading a test bundle needs the `install:upload` scope, because a
  test bundle is code, like an app.
- `espresso` (milestone 2): the test APK, run with `adb shell am instrument` and split with its
  `numShards` and `shardIndex` arguments.

The run coordinator leases `shards` devices, assigns tests round robin to start with and by
recorded duration once there is history, retries failed tests on a fresh device up to `retries`
times, and marks a test flaky when a retry passes. A run holds its leases like any client, so
quotas and the queue apply to it.

Maestro and XCUITest are the suite kinds built so far. For XCUITest, `build` is the archived
Build/Products folder of `build-for-testing`, which holds the app too, and `suite.tests` lists
-only-testing names to shard over; the agent reads results from xcodebuild's output. For
Espresso, `build` is the app's .apk, `suite.testBuild` the test .apk, and `suite.tests` class
names (or `["all"]`); Hangar shards by class rather than with `numShards`, so a failed class
can be retried on its own. `hangar run maestro` uploads the app as a build if it
is a path, then starts a run with the flows folder inline as a base64 tar of up to 10 MB
(`suite: { kind: "maestro", archive, flows }`, where `flows` lists the flow files in it). The
broker's coordinator retries a failed flow on the same device, recorded, rather than on a fresh
one, so the recording link in the run and in JUnit shows the retry. A run's coordinator lives in
the broker process; a run that is going when Hangar stops is marked failed on the next start.
The agent runs `maestro --device <udid>` on the Mac, so each Maestro process sees only its
lease's device. Per-test artifacts are the recordings linked from each flow, so there is no
separate artifacts route yet.

Appium suites do not use runs. They run where they always do, against the Appium endpoint, and
CI parallelises them the usual way.

### Appium endpoint

`/wd/hub` speaks the W3C WebDriver protocol. A new session request becomes a lease: the
capabilities `platformName`, `appium:deviceName` and `appium:platformVersion` map to a device class,
and `hangar:build` names a build. The host runs Appium with the XCUITest or UiAutomator2 driver
bound to the leased device. The broker rejects capabilities that name a `udid` or that would run
host commands, and deleting the session releases the lease. Session creation waits in the queue,
up to `hangar:queueTimeout`.

### MCP

The broker serves remote MCP over streamable HTTP at `/mcp` with the same tokens. Tools:
`lease_device`, `renew_lease`, `release_device`, `list_leases`, `keepalive`, `reattach_lease`,
`observe` (screenshot plus tree), `act` (batched actions), `install_build`, `launch_app`,
`terminate_app`, `open_url`, `app_log`, `js_evaluate`, `js_console`, `network_requests`, `record`,
`report_finding`, `bookings`, the device presets, and mobile-mcp's tool names
([guide](guides/agents.md)). Device tools take `leaseId`, which can be left out when the MCP session
holds exactly one lease. MCP does not upload files.

### Argent pass-through (milestone 2)

`/v1/leases/:id/argent` accepts Argent's `POST /tools/<name>`, so Argent users can point
`ARGENT_TOOLS_URL` at it. The host forwards calls to an Argent tool-server bound to the leased
device, rejects any `udid` argument for another device, and only allows tools on an allowlist (no
tool that takes a host path, no Metro control).

### Console

The broker serves a web console at `/`. People sign in with OIDC.

- **Devices:** every device the person's teams can use, with state, model, OS and host health.
- **Use a device:** lease from the list, see the live screen with touch, keyboard and hardware
  buttons, install a build, open a URL, change locale or permissions, take a screenshot, start and
  stop a recording, read logs, release. "Report a bug" bundles the recording, the last screenshot
  and the logs into a link to paste into the tracker.
- **Runs:** list, per-test results, video of failures, flaky tests over time.
- **Builds:** upload and list.
- **Admin:** hosts, versions, capacity, queue and why a request waits, teams, quotas, tokens,
  phone assignment, audit log.

### SDK, CLI and CI

The client (`import { Hangar } from 'hangar'`) is a typed wrapper over the REST API. `lease()` returns an object that renews
itself and releases on dispose (`await using`). The `hangar` CLI is built on it:

```bash
hangar run maestro ./flows --build ./MyApp.app --shards 4 --junit report.xml
```

Server commands: `hangar up`, `hangar join <link>`, `hangar doctor`, `hangar status`,
`hangar config`, `hangar export` and `hangar import`, `hangar uninstall`.

Client commands: `hangar login <url>` (opens the browser once and stores a token),
`hangar lease --hold`, `hangar install`, `hangar screenshot`, `hangar ui`,
`hangar tap --label "Sign in"`, `hangar watch` (opens the stream). Every client command works
through `npx` without a global install, and finds the broker from `HANGAR_URL`, the last
`hangar login`, or Bonjour on the LAN (`hangar up` advertises itself as `_hangar._tcp`). A GitHub
Action wraps `hangar run` and uploads the JUnit report.

### Admin API

Operator only: `/v1/hosts`, `/v1/devices` (force-wipe, quarantine, enroll, assign to team),
`/v1/teams`, `/v1/images` (declared device images, which agents build), `/v1/classes`,
`/v1/builds`, `/v1/tokens`, `/v1/audit`. Hosts connect at
`/v1/agent/connect`.

## 6. Lease state machine

Leases and devices have separate state machines. A lease ends the moment it is released; the device
it held then goes through its own wipe.

### Lease

```
            +----------+  matched   +-----------+  host ready  +--------+
 request -> |  queued  | ---------> | preparing | -----------> | active |
            +----------+            +-----------+              +--------+
              |                       |      |                     |
              | cancel, queue         |      | host error          | release, expired, idle,
              | timeout               |      | (retry up to 2x     | revoked, device_lost,
              v                       |      |  back to queued)    v preempted, window_closed
            +-----------------------------------------------------------+
            |                    ended (reason)                         |
            +-----------------------------------------------------------+
```

States: `queued`, `preparing`, `active`, `ended`. `ended` is terminal and carries one reason:
`released`, `expired`, `idle`, `revoked`, `device_lost`, `failed`, `cancelled`, `queue_timeout`,
`preempted`, `window_closed`.

- Only `active` leases accept device ops. Anything else returns `LEASE_NOT_ACTIVE` with the state.
- The deadline is `min(lastRenew + ttl, activatedAt + maxSeconds, lastActivity + idle)`, by the
  broker's clock. A scheduler tick every second ends leases past their deadline. A console tab
  that is open and visible counts as activity, and so does `keepalive`.
- `idle` and `maxSeconds` come from the lease's token, under a cap per role (decision 0012).
  When the last event stream of a lease closes, the idle end waits at least the token's grace
  period (60 s by default) after the disconnect, so a client can reattach with the same token.
- An `active` lease can carry `ending` (a reason and a time) when it will end early: two minutes
  after a higher-priority request needs its device (`preempted`), or at its booking's window end,
  told ten minutes before (`window_closed`). Its event stream sends `lease_ending`.
- Renew on a lease that is not `active` fails. An ended lease never comes back.
- `idempotencyKey` returns the existing lease for the same token and key for 24 hours.
- The SDK and CLI renew at a third of the TTL.

### Device

```
 provisioning -> ready -> reserved -> leased -> wiping -> ready
                                       |          |
                                       v          v
                                     held     quarantined -> deleted
                                       |
                                       v
                                     wiping
```

- `ready` devices are in the warm pool, booted, with the class build installed if it names one.
- `reserved` means a lease in `preparing` holds it; `leased` means a lease in `active` does.
- When a lease ends, the device is wiped: for simulators and emulators, shut down and either
  `simctl erase` or delete and re-clone from a golden device (spike 3 picks one), boot, then check
  that installed apps, keychain and photos match the baseline. For phones, uninstall everything not
  in the phone's baseline and clear what the OS allows, since a full erase loses pairing. Only a
  verified device returns to `ready`.
- A failed wipe or health check sends the device to `quarantined` until an operator acts.
- `held` (decision 0012): a run started with `--hold` ends a failed shard's lease into a hold
  instead of a wipe. The device keeps its app state until the hold time ends (at most 4 hours),
  counts against the run's team quota, and can be leased only by a person on that team. When the
  hold ends or that person's lease ends, the device is wiped as usual.

### Invariants

The unit and property tests check these under every interleaving:

1. A device has at most one lease in `preparing` or `active`. A partial unique index on
   `leases(device_id) WHERE state IN ('preparing','active')` enforces it, so a scheduler race fails
   the insert instead of double-leasing.
2. A device that held a lease is not leased again until it passed a verified wipe.
3. Every lease reaches `ended` in bounded time: queue timeout, preparation timeout (5 minutes by
   default), or its deadline.
4. Ops on ended leases are refused at both the broker and the host.
5. A team never holds more active leases than its quota.
6. A device belongs to at most one booking at any moment.
7. A `ci` request that arrives while a booking's agents hold every device gets a device within
   two minutes and five seconds.
8. A booked lease never outlives its window.
9. A held device is wiped before anyone outside its run's team leases it.

### Scheduling

Requests wait per class. Each lease has a priority from its token: `ci` above `interactive` above
`booked`. When a device becomes `ready`, the scheduler picks among queued requests that match it
and whose team is under its quota: the highest priority first, run shards before agent leases
inside a booking, then the team with the fewest active leases relative to its quota, then the
principal with the fewest active leases, then the oldest request.

An open booking keeps free devices for itself up to its count, never a host's CI floor (1 device
by default). Only the booking's own tokens lease from it, and only `ci` requests may take a device
it keeps free. A `ci` request that finds nothing free waits for a device that is coming back;
failing that, it tells the lowest-priority lease it could use, agent leases before run shards and
newest first, to end in two minutes (`preempted`). An `interactive` request never ends a booked
lease, so it waits. Booked leases are told ten minutes before their window closes. The scheduler is a pure function
from queued requests, ready and returning devices, live leases, bookings, holds, quotas and the
time to assignments, early endings and reserved devices, so it is tested without a clock or a
database (decision 0012).

Admission to boot a new simulator is by memory, not a fixed count: the host reports free memory
and memory pressure, and the broker only asks it to boot when the class's measured footprint fits.
Simlock's RAM budget is the reference.

### Failures

- **Host disconnects.** Its leases stay `active` for a grace period (60 s by default). If the host
  does not come back, they end with `device_lost`, run shards on them are retried elsewhere, and
  the devices are quarantined. On reconnect the host wipes them before reporting them `ready`.
- **Broker restarts.** State is in the database. Hosts reconnect with their inventory and lease
  table, and the broker reconciles.
- **Broker gone for a long time.** Each lease the host holds carries its deadline. The host ends
  and wipes leases past their deadline plus the grace period on its own.

## 7. Security model

The tenants are people and programs in teams that mostly trust each other: one company, or a few
teams in it. Hangar still enforces boundaries, because a CI job, an AI agent and a contractor
should not be able to read each other's devices or run commands on the Macs by accident or on
purpose.

### Roles

| Role | Gets |
|---|---|
| `member` | Lease devices the team can use, drive its own leases, install registered builds, start runs, read the team's runs and recordings. |
| `team-admin` | Everything a member gets for the whole team; team tokens; build uploads; phone assignment within the team. |
| `operator` | Everything everywhere: hosts, teams, quotas, classes, revoking leases, the audit log. |
| `host` | Connect at `/v1/agent/connect` as one specific host. Nothing else. |

Scopes narrow tokens further. `install:upload` allows uploading app and test bundles, and is off
by default for member tokens.

People sign in one of three ways, and all of them end in an HttpOnly, SameSite=Lax session cookie:

- **Built-in accounts, the default.** `hangar up` prints a one-use admin link that expires in 30
  minutes. Admins invite people with links that expire after 7 days and carry a role. A person
  sets a passkey or a password the first time. Nothing else is needed.
- **OIDC**, when the team sets an issuer (authorization code with PKCE). Config maps OIDC groups to
  teams and roles. Built-in accounts can then be turned off.
- **A trusted sign-in proxy header** (as in Simlock), for setups behind Cloudflare Access or
  similar.

### Tokens

Opaque: a prefix for the kind, then 32 random bytes in base32, for example `hgr_member_...`,
`hgr_host_...`, `hgr_stream_...`, `hgr_join_...`. A join token is what the "Add another Mac" link
carries: it works once, within 24 hours, and the broker swaps it for a host token when the new
host connects. The broker stores the SHA-256 hash, shows the token once, and
checks it on every request, so revocation is immediate. Tokens have an owner (a person or a team),
optional scopes and an optional expiry. Stream tokens are bound to one lease and expire 5 minutes
after minting if unused.

### Enforcement points

1. **Broker.** Every request maps to a principal, a team, a role and, for device ops, lease
   ownership. A lease id that belongs to someone else returns `404`, so ids do not leak.
2. **Host.** The broker sends `{ leaseId, op, args }`. The host looks up the device in its own
   lease table and rejects the op if it holds no active lease with that id. No message type carries
   a UDID, a host path or a shell command; the op set is a fixed list in code. Test runners are
   started by the host with arguments it builds itself.
3. **Drivers.** The host calls `simctl`, `idb`, `adb`, `xcodebuild` and Maestro with `execFile` and
   an argument array, never a shell, with the device id from its own table. URLs for `open-url`
   must use a scheme on the operator's allowlist.
4. **Wipe.** Erase on release is on for every lease. Operators can turn it off only for a class of
   long-lived debug devices, and the console marks those devices.
5. **Data.** Screenshots and logs are not stored unless a recording or run asks for them. Stored
   artifacts belong to the team, expire after the team's retention (14 days by default), and are
   deleted with the run or recording.
6. **Audit.** Lease and run events and op types, not their content, go to an audit table with the
   principal and team.

A stolen member token can drive that person's leases and start leases within the team's quota. A
compromised broker can drive any device but still cannot run a command on a host, with the
exception below.

### The Metro tunnel

The tunnel's port is on the Mac's loopback, which every simulator on that Mac shares. Another
lease's app on the same Mac could connect to it and reach the developer's Metro, which serves
their app's source. Teams that do not trust each other's apps use separate Macs, as for app
uploads below. The tunnel only ever reaches the lease holder's own machine, and only the port
their CLI chose.

### Maestro flows

A flow can run JavaScript (`runScript`, `evalScript`) in Maestro's own script engine on the Mac,
with HTTP access. Hangar treats a flows folder like a test bundle: it runs on the host next to
the device. Today any member can send flows to their own lease; whether that needs the
`install:upload` scope is open question 8.

### Where it stops: apps and test bundles run code on the Mac

An iOS simulator app, or an XCUITest bundle, is a native macOS process running as the host
agent's user. The simulator puts no security boundary between that process and the Mac.
Installing an arbitrary `.app` is close to running code on the host as `hangar`. So:

- By default only registered builds can be installed. Uploads need `install:upload`, which team
  admins grant to CI and to people they choose.
- The `hangar` user is not an admin and holds no SSH keys or cloud credentials. Its only secret is
  the host token, which can act as that one host and nothing else.
- Android emulators are VMs, so app code stays in the guest. Phones have their own OS sandbox. The
  gap is specific to iOS simulators.
- Teams that do not trust each other's code should get separate hosts. Hosts can be assigned to
  teams for this.

The README will say this plainly.

### Transport

Clients to broker over HTTPS through the ingress, or over plain HTTP on a LAN in single-Mac mode
with the warning described in section 3. Host to broker over WSS; the host checks the
broker certificate against the system store or a pinned CA file. Plain `ws://` needs an explicit
`allowInsecure` flag and logs a warning on every connect. Media is WebRTC with DTLS-SRTP.

### Not in scope

Hostile operators, physical access to the Macs, an attacker who already has the `hangar` user's
shell.

### Apple's license

The macOS license (Tahoe, section 2I) rules out using macOS for a "service bureau, time-sharing,
terminal sharing, relay service or other similar types of services", and says that applies inside
your own organization too. Leasing Macs to others needs at least 24 hours of exclusive use per
lessee and notice to Apple (section 3). Internal CI farms on Mac minis are common practice, but
this is not legal advice. Hangar is software a team runs on Macs it owns for its own development and
testing. The README will say that, point to Apple's license, and not offer or encourage running it
as a service for others. Simulators are not macOS VMs, so the two-VM limit does not apply to them.

### No telemetry

Hangar sends nothing anywhere. Logs go to stdout and the audit table. Metrics are a Prometheus
endpoint you scrape.

## 8. Drivers

Drivers are the part that breaks with each Xcode release. Each sits behind one interface on the
host (`create`, `boot`, `erase`, `screenshot`, `describe`, `tap`, `swipe`, `type`, `key`,
`install`, `launch`, `terminate`, `openUrl`, `settings`, `logs`, `videoStream`) and pins its
version.

### iOS simulator (milestone 1)

- Lifecycle: `xcrun simctl` (create, clone, boot, shutdown, erase, delete, install, launch,
  terminate, openurl, privacy, status bar, location, screenshots).
- Input and accessibility: idb companion (meta/idb, MIT, v1.7.8 on 2026-11-01, actively
  maintained), one companion per booted device.
- Video: `idb video-stream --format h264`, encoded by VideoToolbox on the hardware encoder.
- Slim mode: turn off simulator background services not needed for testing, as simslim and
  Simlock's slim mode do, to fit more simulators per Mac.

Known risk: open idb issues on iOS 26 report `describe-all` returning a single element (#964),
tap coordinates off by the screen scale, and an empty tree after `idb ui quiet` (#985). Spike 1
checks idb on Xcode 26.6 with a React Native app. Fallbacks: AXe (MIT, idb-derived, says it supports
Xcode 26 and 27) for the tree, serve-sim (Apache-2.0) for video and input.

### Android emulator and Android phones (milestone 2)

`adb` for install, launch, intents and settings. The emulator gRPC interface on loopback for
touch, keys, screenshots and snapshot load (fast reset). Appium's UiAutomator2 server for the tree,
which avoids a process spawn per call. scrcpy server 5.0.1 (Apache-2.0) for video and for input on
phones, pinned to the client protocol version. Phones use the same stack without gRPC.

### Physical iPhone (milestone 3)

`devicectl` for install and launch, WebDriverAgent for input and the tree, go-ios (MIT) for
tunnels and screenshots. Not pymobiledevice3, which is GPL-3.0. Live video from a physical iPhone
has no good open option yet; Simlock's capture needs Xcode 27 and iOS 27. Until there is one, the
console shows a screenshot refreshed after every action.

### Runners

Maestro CLI and `xcodebuild` on the host, Appium server with the XCUITest and UiAutomator2
drivers. Versions pinned like the drivers.

### Version pinning and smoke tests

`hosts/versions.json` lists the Xcode versions, runtimes, idb, Appium, Maestro and scrcpy versions
each release is tested with. A host reports its versions on connect. The broker shows mismatches
and stops scheduling on a host whose Xcode is not in the tested list, unless an operator overrides
it. CI runs a smoke test per supported Xcode and runtime pair: boot, install a fixture app,
screenshot, read the tree, tap by label, run a two-flow Maestro suite, wipe, verify the wipe.

## 9. Streaming

Decision 0007 has the reasoning and the measurements.

- Capture and encode are native. A small Swift helper per streamed device (`hangar-screen`,
  built from source with the Xcode toolchain on first use) reads the simulator's display
  IOSurface through SimulatorKit, and encodes only when the display reports damage, with
  VideoToolbox H.264 in low-latency mode. The IOSurface goes to the encoder without a copy.
- One encoder per device, started when the first viewer connects and stopped when the last one
  leaves. Viewers share the packets; a new viewer gets a keyframe.
- Frames are binary end to end: the helper's framing (length, keyframe flag, capture timestamp,
  size, Annex B) goes unchanged from agent to broker to browser. No JSON or base64 per frame.
- Under backpressure the broker drops frames for that viewer until the next keyframe. It never
  queues video.
- On HTTPS and on localhost, the console decodes with WebCodecs. On a plain-HTTP LAN page, where
  browsers do not offer WebCodecs, it falls back to JPEG frames. Closing that gap (WebRTC, MSE or
  HTTPS by default) is an open question in section 14.
- Input from the console goes over the same WebSocket. Only the lease holder's input is accepted.
- Every frame carries its capture time, so `bench/stream` reports latency per stage: capture to
  encoded, to the broker, to the browser, to decoded.
- Recordings are the same H.264 stream written to MP4 on the host.

## 10. Agent to broker protocol

One WebSocket per host to `/v1/agent/connect`, authenticated with the host token.

- JSON text frames: requests with an `id`, responses that echo it with `ok` or `error`, and events
  without an `id`.
- Binary frames for screenshots and log batches, with an 8-byte header holding the request id and
  a chunk flag.
- Builds, test bundles and recordings do not go over the socket. The host downloads and uploads
  them over HTTPS with one-use URLs, and caches downloads by SHA-256.
- Pings every 15 s; 3 missed pings close the socket.
- The first message is `hello`: protocol version, host id, versions, capacity, memory, inventory
  and lease table. The broker answers `welcome` with pool targets, or `incompatible` and closes.
- The broker supports the current protocol version and the one before, so hosts upgrade one at a
  time.

Message types: `hello`, `welcome`, `pool`, `inventory`, `health`, `lease.prepare`, `lease.ready`,
`lease.end`, `op`, `run.shard.start`, `run.test` (per-test result), `run.shard.end`,
`stream.offer`, `stream.answer`, `log`.

## 11. Milestones

The milestones, their done criteria and the spikes that come first are in
[ROADMAP.md](../ROADMAP.md). In short:

1. One Mac, iOS simulators: `hangar up`, leases, the device API, MCP, SDK, CLI, built-in accounts,
   the console with the native H.264 stream, and the benchmarks.
2. React Native workflow: `hangar run ios`, Metro through the broker, the debugger and dev menu
   through the lease, and Maestro runs sharded over devices.
3. Android emulators and phones, several hosts through `hangar join`, the Appium endpoint, OIDC,
   teams and quotas.
4. Device images and physical iPhones.

## 12. Tests and CI

- Lease state machine and scheduler: unit tests on the pure functions, and a property test that
  runs random sequences of requests, releases, host disconnects, quota changes and clock jumps
  against the invariants in section 6.
- Run coordinator: unit tests for sharding, retries and flaky marking against a fake host.
- Broker API: tests against an in-memory SQLite and a fake host speaking the protocol.
- Host agent: tests against a fake driver.
- End-to-end: a self-hosted CI runner on a real Mac with one simulator runs the milestone 1 done
  list.
- Driver and runner smoke test per supported Xcode and runtime pair (section 8).

## 13. Repository layout

One pnpm workspace with five packages, one per process plus what both ends share. Decision 0010
merged the driver packages into the agent and the client into the CLI.

```
hangar/
  README.md  ROADMAP.md  CONTRIBUTING.md  SECURITY.md  LICENSE  NOTICE
  Dockerfile  action.yml
  packages/
    protocol/             types and the wire format, shared by every package
    broker/src/
      http.ts             REST routes and error mapping
      mcp.ts              MCP tools, thin calls into the same services
      auth.ts  oidc.ts    tokens, roles, single sign-on
      leases/             lease state machine and scheduler (pure functions)
      hosts.ts  agents.ts agent connections, the agent socket, reconcile on hello
      runs.ts             sharding, retries, flaky marking, JUnit merge
      stream.ts tunnel.ts live screen relay and the Metro tunnel
      images.ts           device images
      store.ts  db.ts     disk or S3, SQLite
    agent/
      src/index.ts        the iOS host: warm pool, leases, ops
      src/android.ts      the Android host
      src/connect.ts      `hangar join`: the socket to a broker, reconnect
      src/drivers/ios/    simctl and the idb companion's gRPC
      src/drivers/android/ adb and the emulator
      native/screen.swift capture, H.264, recordings, JPEG conversion
    console/              web console, plain JavaScript, served by the broker
    hangar/
      src/main.ts         the hangar command
      src/client/         the TypeScript client, exported as `hangar`
  e2e/  bench/            end-to-end tests and benchmarks on a real Mac
  deploy/helm/            chart for the broker
  docs/                   design, decisions, guides
```

The broker never imports the agent or a driver; it only knows the protocol.

The user docs folders start empty and fill as each milestone ships. Each page describes what
exists, not what is planned.

## 14. Open questions for review

1. Is the console with touch input in milestone 1 right, or should milestone 1 stay API-only?
2. The React Native workflow in milestone 2, before Android and several hosts: is that the
   right order?
3. Is the security model's line (API-level isolation on iOS simulators, uploads behind a scope,
   separate hosts for teams that do not trust each other) acceptable for the README?
4. Should Apple's license question get a legal review before the first public release?
5. The name.
6. Full-quality video on a plain-HTTP LAN page, where browsers do not offer WebCodecs: WebRTC
   (a native dependency and UDP to the Mac), MSE with fragmented MP4 (more buffering), or HTTPS
   by default (a certificate step). To be decided with `bench/stream` numbers.
7. Sandboxing: the agent as its own macOS user on bare metal, with an optional Tart VM image
   that users build themselves. A macOS VM loses the hardware video encoder and is capped at two
   per Mac, so it cannot be the default.
8. Should sending Maestro flows need the `install:upload` scope, like apps and test bundles?
   And should members be allowed to upload their own debug builds (which `hangar run ios`
   needs), perhaps on hosts marked for it?
