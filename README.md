# Hangar

Turn the Macs your team already owns into a pool of iOS simulators and Android emulators.
Developers, QA, CI and AI agents lease a fresh device, use it in the browser or from code, and
give it back wiped. Self-hosted, no per-minute fees, no account anywhere.

```bash
git clone https://github.com/mariusud/hangar && cd hangar
pnpm install && npm install -g ./packages/hangar
hangar up
```

Open the link it prints. It signs you in as admin, and the console lists the simulators ready to
use. Invite your team from the People page.

## Use it

**Your app on a leased simulator**, with Fast Refresh from Metro on your laptop:

```bash
hangar login http://your-mac.local:7420
hangar run ios          # or: hangar run android
```

**Maestro in CI**, sharded over fresh devices, flaky tests retried and recorded:

```bash
hangar run maestro .maestro --app MyApp.app --shards 3
```

**An AI agent** gets its own device over MCP. The console's Connect page has the line for your
editor, with a token filled in:

```bash
claude mcp add --transport http hangar http://your-mac.local:7420/mcp \
  --header "Authorization: Bearer <token from the Connect page>"
```

**A tester** opens the console, picks a device, installs a build and presses Record. Stopping it
gives a link with the video, every tap and the app log, ready for the bug report.

## Needs

A Mac with Xcode, Node 22, pnpm and Facebook's idb. `hangar doctor` checks all of it and prints
the command for anything missing. Add Android emulators with `hangar up --android <avd>`.

## Guides

| | |
|---|---|
| [Your Expo or React Native app](docs/guides/expo.md) | `hangar run ios`, Metro and DevTools through Hangar |
| [GitHub Actions](docs/guides/github-actions.md) | Maestro on every pull request, with JUnit and recordings |
| [AI agents](docs/guides/agents.md) | MCP setup; works with agents written for mobile-mcp |
| [Recording a bug](docs/guides/recordings.md) | video, timeline and app log behind one link |
| [Android emulators](docs/guides/android.md) | emulators next to the simulators |
| [XCUITest](docs/guides/xcuitest.md) | native iOS test suites, sharded the same way (Espresso is in the Android guide) |
| [Device images](docs/guides/device-images.md) | devices ready with your app, locale and appearance |
| [More Macs](docs/guides/more-macs.md) | `hangar join`, the broker in Docker or Kubernetes |
| [Single sign-on](docs/guides/sso.md) | any OpenID Connect provider, groups to teams |
| [What a leased app can reach](docs/guides/isolation.md) | running Hangar as its own macOS user |

Everything else: [all features](docs/features.md), [measured numbers](docs/numbers.md),
[design](docs/design.md), [roadmap](ROADMAP.md).

## Speed

On an M4 Pro, through the real broker and agent:

| | |
|---|---|
| Live screen | 52 fps, H.264, about 500 KB/s |
| Swipe to first changed frame | 109 ms p50, 197 ms p95 |
| Save a file to Fast Refresh on the leased device | 87 ms p50 |
| JPEG screenshot, element tree | 39 ms, 3 to 5 ms |

## Status

Early, and not on npm yet. Everything above runs on one Mac. More Macs join with `hangar join`,
which so far is only tested on one machine. A leased iOS app runs as a
process on the Mac, so use separate Macs for teams that do not trust each other's code. Hangar
runs on hardware you own, for your own development and testing; read Apple's macOS license for
what that allows.

Apache-2.0. Hangar sends no telemetry and needs no internet access.
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
