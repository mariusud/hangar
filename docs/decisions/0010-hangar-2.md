# 0010: Hangar 2

Status: Accepted. Progress is tracked in ROADMAP.md under Hangar 2.

## Pitch

Hangar turns the Macs your team already owns into one pool of simulators and emulators. Open one
in a browser with hot reload, shard tests over them in CI, and hand them to AI agents. No
per-minute fees, no vendor account.

## What the research found

Hosted farms charge per minute or per slot: AWS Device Farm $0.17/device-min, Appetize $0.06/min
over plan, Maestro Cloud about $250/device/month, and Expo Simulators (beta) $0.10/min from 2027.
Reviews of hosted farms complain about input lag, queues for popular devices and dropped
sessions. None of them carry a Metro dev loop.

The open source option, DeviceFarmer/STF, is Android-first, with iOS "experimental". Its README
says it has little security between processes and does not fully reset devices between sessions.

AI agents already have good MCP servers for local devices: mobile-mcp (10.4k stars, 34 tools),
XcodeBuildMCP (about 6.5k) and Argent (3.2k). None of them hands out a device from a shared pool
or keeps parallel agents apart. mobile-mcp already has allocate and release tools for remote
providers.

Fast-adopted self-hosted tools share three traits: one install command (Coolify, Dokploy), one
port and one volume (Uptime Kuma, 93k stars), and a public demo that resets itself (Uptime Kuma).

Streaming: Tapflow, the closest public analogue, sends VideoToolbox H.264 over a WebSocket and
measured about 50 ms p95 across a LAN once it used WebCodecs. WebRTC wins on lossy links and
because video can skip the broker. Pion (Go) and libdatachannel can both send already-encoded
H.264 without re-encoding.

Isolation: a simulator app is a host process. A VM is the only real boundary. Apple allows two
macOS VMs per Mac, and Tart clones a VM in under a second by APFS copy-on-write.

Measured on this Mac, M-series laptop, iOS 26.5:

| Operation | Median | Max |
| --- | --- | --- |
| `simctl clone` of a 1.3 GB golden device | 3.1 s | 3.1 s |
| Read the element tree (`describe`) | 303 ms | 1079 ms |
| Tap at a point (HID) | 4 ms | 356 ms |
| JPEG screenshot, 800 px | 594 ms | 1016 ms |

The tree read and the screenshot are slow because each spawns processes (`simctl`, `sips`). The
tap is fast because it already goes over gRPC to the idb companion, which stays running.

## Decisions

### 1. One idea: the lease

Everything is a lease of one device. A person in the console holds one. A CI run is N leases. An
AI agent's session is one lease. A device image is only a kind of lease. There is no second
scheduling path, no second API for agents, no separate test-runner service.

```
            person          CI run              AI agent
               │       ┌──────┼──────┐             │
               ▼       ▼      ▼      ▼             ▼
            lease    lease  lease  lease         lease
               └───────┴──────┴──────┴─────────────┘
                              scheduler
```

### 2. Control and media split

The broker keeps what it is good at: accounts, the queue, the scheduler, history, builds. Video
and input stop going through it. The browser and the host connect directly with WebRTC, and the
broker only passes the offer and answer. When a direct path fails, video goes through a TURN
relay built into the broker, on port 443. Today's WebSocket relay stays as the last fallback.

```
 browser ──HTTPS──▶ broker ◀──WS (control)── host
    │      signaling only                      │
    └──────────── WebRTC: video, input ────────┘
                 (TURN in the broker if needed)
```

Input rides two data channels. Touch moves go unordered with no retransmits, because a late move
is useless. Taps, keys and text go on a reliable channel, so a lost key-up cannot stick a key.

Metro traffic stays on the broker's tunnel. It is a few MB per reload and is not latency bound
like video.

Measured first. `bench/stream.baseline.json` (M4 Pro, 2026-11-06) splits a scroll
into its parts:

| Part | p50 | p95 |
| --- | --- | --- |
| Input to the simulator capturing a changed frame | 77 ms | 327 ms |
| Capture to the viewer's socket (WebSocket, through the broker) | 9 ms | 20 ms |

On one machine the transport is 20 ms of the 339 ms p95. The time goes before capture: input
reaching the simulator and the simulator drawing. So the input path is worked on first, and
WebRTC waits for a measurement across a real WAN, which this Mac cannot make without changing
system network settings.

The input path, traced: the viewer's swipe reaches the HID call in 1 to 7 ms, and the first
changed frame comes 56 to 112 ms after that. Straight on the driver, mid-list, the first frame
comes in 18 ms p50. The rest is iOS deciding that a touch on a table row is a scroll. Hangar's
own share of a remote input is a few milliseconds each way.

### 3. One native helper per host, always running

The Swift helper that already streams H.264 and injects touches grows to own every hot path on
iOS: capture from the simulator's IOSurface, encode, touch and key input, screenshots and the
element tree. The agent talks to it over one binary pipe. No process spawn per call.

Targets: screenshot under 50 ms, element tree under 100 ms, tap by label under 120 ms. The numbers
above are the before.

What happened: the companion already had the calls, so the agent asks it over gRPC instead of
spawning the idb CLI. The tree went from 303 ms to 3 to 5 ms, so a tap by label is now under
20 ms. A PNG screenshot went from 302 ms to 91 ms. A JPEG went from 594 ms to 95 to 210 ms
through a converter that stays running in the Swift helper; under 50 ms needs the IOSurface
capture. A second pass did that: the helper's image process now reads the simulator's
display IOSurface directly and encodes the JPEG with ImageIO, 39 ms median at 800 px, measured
while the Mac was busy with other work.

### 4. Two isolation levels, named honestly

- Shared (default). For a team's own apps. The agent runs as its own macOS user, `hangar`, so
  leases cannot read the developer's files. A separate device set (`simctl --set`) was tried on
  paper and dropped: Maestro and `xcodebuild -destination id=` only find devices in the user's
  default set.
  The docs say plainly that this is not a security boundary between leases.
- Hardened. For apps from outside the team, or a Mac someone also works on. The whole host
  (agent and its simulators) runs in one Tart macOS VM and joins with `hangar join`, like any
  other host. Leased apps can read only the VM's files, and with Tart's `--net-softnet` they
  cannot reach the Mac itself. One VM image with a pinned Xcode, copied to every Mac, also makes
  device images the same everywhere.

  Why not one VM per lease: Apple allows two macOS VMs per Mac (in the EULA and enforced by the
  hypervisor), so a Mac would hold two leases. And inside a per-lease VM the app still shares
  the VM with the agent that drives it, so it buys little over a host VM.

  Why not the default: it costs a VM's memory per Mac, and it likely loses the hardware video
  encoder. The only report found says VideoToolbox in a Virtualization.framework guest needs a
  restricted Apple entitlement for hardware encoding and otherwise uses the software encoder
  (github.com/catinthesack/avm). Software H.264 at a phone's full resolution is a CPU cost per
  stream that has to be measured. Metal works in the guest through the paravirtualized GPU, at
  an older feature level (tart discussions 344).

  Before it ships, measured on one Mac: simulator boot and frame rate in the guest, hardware or
  software encode and its CPU per stream, clone and boot time to ready, idle guest memory, and
  simulators per guest. Tart's license (FSL-1.1-ALv2, which allows any use except a "Competing
  Use") needs a reading; Hangar would not ship Tart, the operator installs it.

  Android emulators cannot run inside a macOS guest, which gets no nested virtualization. They
  stay on the Mac.

The scheduler treats the level as part of the device class, so a run can ask for isolated
devices.

### 5. Install in one command, run with no settings

```
brew install hangar        # or: npx hangar
hangar up                  # broker, agent and console on this Mac, prints a sign-in link
```

`hangar up` finds Xcode's runtimes and Android AVDs by itself. One port, one data folder. The
broker also ships as one Docker image with one volume. A public demo resets every 10 minutes.

### 6. Agents first

`hangar mcp` gives each AI agent session its own lease, released when the session ends. The tool
names and arguments follow mobile-mcp where they overlap, so agents written for it work
unchanged. Leasing, the device pool and the live view are the additions.

### 7. Smaller changes the expert review asked for

- Shards are balanced by past durations, longest first, instead of round robin.
- A device image's golden device is named after the runtime it was built on, so an Xcode or
  runtime update builds it again. Hosts on different runtimes still offer the same image name;
  `class.os` picks between them.
- Flaky results keep a history per test, shown as a trend, not a label on one run.

## The new shape

```
 packages/
   protocol/     types and the wire format          (as today)
   broker/       HTTP, scheduler, SQLite, signaling, TURN
   agent/        one host: pool, leases, iOS and Android drivers, the Swift helper
   console/      the web app
   hangar/       the CLI and the TypeScript client, one package, `npx hangar`
```

Eight packages become five. The drivers move into the agent, because nothing else uses them, and
the CLI and client merge, because the CLI is the client's main user.

The language stays TypeScript on Node 22, with Swift for the hot path. Most React Native teams
read TypeScript, the MCP SDK is TypeScript, and the scheduler, leases, runs and their tests carry
over. A Go rewrite would give one static binary and Pion, but it would throw away tested code
and the contributors most likely to show up.

## What stays

The lease and device state machines, the pure scheduler and its property tests, agents dialing
out with a host token, delete-and-clone as the wipe, no UDID or path in the API, SQLite until the
broker runs as more than one process (decision 0009), and the runs, teams, SSO and S3 features.

## Order of work

1. Measure: WebSocket video p95 on a LAN and across a WAN. Same script before and after.
2. Native helper owns screenshot and tree. Measured against the table above.
3. Package merge: drivers into agent, CLI and client into `hangar`.
4. MCP compatible with mobile-mcp tool names, one lease per session.
5. The `hangar` macOS user and device set for the shared level.
6. WebRTC with TURN in the broker, if step 1 says it is needed.
7. Isolated level with Tart VMs.
8. Brew formula, Docker image, public demo.

Steps 1 to 5 can be done and verified on one Mac. Steps 6 and 7 need a second network and a
macOS VM image of about 25 GB.

## Not verified

The Tart VM boot time and simulator frame rate inside a VM. The share of office networks that
need TURN. Whether node-datachannel exposes the media API from JavaScript. Appetize and
BrowserStack latency. Each gets measured or prototyped before its step starts.
