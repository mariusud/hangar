# Changelog

## Unreleased

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
