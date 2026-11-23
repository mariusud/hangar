# Changelog

## Unreleased

- The project is now called Devicepool. Commands, variables (`DEVICEPOOL_*`), the data folder
  (`~/.devicepool`) and the `<devicepool-screen>` element follow. New tokens start with `dp_`; old
  ones stay valid.
- `pnpm build:npm` builds the npm package in `dist/npm`.
- Android phones over USB with `devicepool up --phones`. Experimental: tested with a fake phone
  only. A phone is wiped by undoing the lease and reading it back, and quarantined on a mismatch.
- The GitHub Action runs with no server on a macOS runner when `url` is empty. Not yet run on a
  real runner. A `build-name` input and `--build-name` let prefix-limited CI tokens upload.
- A broker restart no longer ends active leases: a lease whose host has not reconnected is kept
  for 60 seconds after the broker starts. A host that has lost the broker ends and wipes leases 60
  seconds past their deadline.
- A malformed agent message is logged and dropped, the lease scheduler keeps running past a
  failing lease, and `up`, `broker` and `join` log unhandled rejections instead of dying.
- One account may hold at most 50 queued or running leases and a run at most 50 shards
  (`DEVICEPOOL_MAX_LEASES_PER_ACCOUNT`, `DEVICEPOOL_MAX_SHARDS`).
- Sign-in attempts are limited: five failures in 10 minutes block that name or address for 60
  seconds. At most four password hashes run at once.
- Single sign-on: optional `DEVICEPOOL_OIDC_DOMAINS`, a warning when neither it nor
  `DEVICEPOOL_OIDC_GROUPS` is set, and the sign-in is tied to the browser that started it.
- Requests that use the session cookie from another origin are refused. The console is served
  with nosniff, frame and Content-Security-Policy headers.
- A second lease asking for a tunnel port another iOS lease holds gets `TUNNEL_PORT_BUSY` instead
  of a silent random port. Ports below 1024 are refused.
- A second Devicepool or `join` on a Mac that already runs one refuses to start instead of
  deleting the first one's simulators.
- Usage mistakes print one line and exit 2 instead of a stack trace, and numeric options are
  range-checked. `DEVICEPOOL_DEBUG=1` shows the stack of other errors.
- `devicepool join` says when the broker cannot be reached. `up --install` reports why the service
  did not start. `devicepool lease` prints the queue position every 30 seconds.
- A refused token says so, mistyped app paths say "No such file", and device builds are refused
  with the `-sdk iphonesimulator` hint.
- `devicepool export` writes its tar readable only by the owner.
- Fixed: after the rename no simulator became ready, because the idb companion's socket path was
  longer than macOS allows.

- `POST /v1/leases/:id/tokens` makes a token that drives only that lease and ends with it.
- `devicepool run ios --build NAME` and `run android --build NAME` install a build Devicepool already
  has, so they run without Xcode or Gradle, for example on Linux. `--lease` (or `DEVICEPOOL_LEASE`)
  runs on a lease made elsewhere.
- `devicepool run` takes more than one `--port`. The first is Metro; the others are forwarded over
  the same tunnel and show up on the device as `localhost:<port>`.

## 0.1.0 (2026-11-15)

The first tagged release. Devicepool runs on one Mac or several, and has run for a week on a Mac
mini with a cloud service leasing devices over Tailscale. It is not on npm yet; run it from a
checkout with `node packages/devicepool/src/main.ts`.

What it does is in [docs/features.md](docs/features.md). In short:

- `devicepool up` keeps a warm pool of iOS simulators, and Android emulators with `--android`, and
  hands them out as leases with a fair queue, idle and longest-lease limits and a wipe after
  each lease.
- A REST API, a CLI, a client library and an MCP server for agents, and a console with a live
  H.264 screen and input.
- `devicepool run maestro`, `run xcuitest` and `run espresso` shard tests over fresh devices, retry
  failed tests once, mark flaky ones, write JUnit and keep a recording of each failure.
- `devicepool run ios` and `run android` load JavaScript from your own Metro through the broker, with
  Fast Refresh, and React Native DevTools on iOS.
- Device images with apps, locale, appearance, permissions and a sign-in flow; bookings; teams
  and quotas; OIDC sign-in; S3 storage; `devicepool join` for more Macs; a broker container and a
  Helm chart.

Changed after the Mac mini trial:

- The API accepts points as `{x, y}` as well as `[x, y]`.
- A lease still queued when its `?wait` request disconnects ends, so it never takes a device
  nobody holds.
- When a lease queues for an image, a full Mac wipes an idle warm device of another class to
  make room for it.
- `devicepool image capture <name> <lease-id>` saves a device set up by hand as an image, for
  sign-ins a script can't do.
- The console's viewer is `/screen.js`, with a `<devicepool-screen>` element, and `proxyStream` lets
  your own server pass a lease's stream on with the token added there
  ([guide](docs/guides/embed-screen.md)).
- `devicepool` finds idb, Maestro and Homebrew tools in their usual folders even when they are not on
  PATH, as when it is started over ssh.
- `devicepool --version`.
