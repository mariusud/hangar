<p align="center"><img src="docs/assets/header.png" alt="Devicepool: the open source, self-hosted device farm. iOS simulators and Android emulators for your team, your CI and your AI agents." width="100%" /></p>

Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents.

It runs the devices on your own Macs and lends them out one at a time. When a lease ends,
Devicepool wipes the device and puts it back in the pool. It is free under Apache-2.0 and needs no
account. You can use it for simulator and emulator work instead of a hosted device cloud; the
[alternatives pages](docs/alternatives/index.md) compare it with Maestro Cloud, AWS Device Farm,
BrowserStack App Live, Appetize and Expo Simulators. Physical phones are on the
[roadmap](ROADMAP.md).

## What you can use it for

- **Develop on a device you don't have.** `devicepool run ios` builds your app, borrows a
  simulator and connects it to Metro on your laptop. Fast Refresh, React DevTools and the debugger
  work as they do locally.
- **Test every pull request.** The GitHub Action splits your Maestro flows over fresh devices,
  runs a failed flow once more, and writes one JUnit report with a video of each failure.
  XCUITest runs against a real UI test target in the end-to-end test. Espresso runs are built but
  haven't run against a real test APK yet.
- **Let AI agents check their own work.** Devicepool is an MCP server for iOS simulators and
  Android emulators. Claude Code, Codex, Cursor or any MCP client can take a device, tap through
  your app and read what is on the screen.
- **Try a build by hand.** Open a device in the browser, click and type on it, and send a
  recording of the bug as a link.

## Start

On the Mac that will hold the devices, such as a Mac mini in the office:

```bash
git clone https://github.com/mariusud/devicepool && cd devicepool
pnpm install && npm install -g ./packages/devicepool
devicepool up
```

Open the link it prints to see the devices. Invite your team from the console's People page.

<p align="center"><img src="docs/assets/how-it-works.gif" alt="Claude taps through a sign-in screen on one iPhone, a pull request runs 12 Maestro flows on three more, and a developer saves a file and sees the change on a fourth. Devicepool wipes each device when they finish." width="100%" /></p>

## Connect

| To use devices from | Run |
|---|---|
| Claude Code | `devicepool connect claude`, or the plugin: `/plugin install devicepool --marketplace mariusud/devicepool` with `DEVICEPOOL_URL` and `DEVICEPOOL_TOKEN` set |
| Codex | `devicepool connect codex` |
| Cursor or another MCP client | `devicepool connect cursor` |
| Maestro in CI | `devicepool connect ci`, then paste the two secrets and the step it prints |
| Maestro in CI with no Mac of your own | the GitHub Action without `url`, on a `macos-26` runner; not yet run on a real runner ([guide](docs/guides/github-actions.md#on-the-runner-with-no-server)) |
| Your React Native app, with Fast Refresh | `devicepool run ios` or `devicepool run android` in your app's folder |
| A test by hand | the console: Use one, then Record for a bug link |
| Your own code | `const device = await devicepool.lease()` ([client](docs/guides/agents.md#rest-for-agents-with-their-own-tools)) |

These work on the Devicepool Mac as they are. On your laptop, install the CLI the same way and
run `devicepool login http://your-mac.local:7420` once. Your CI also has to reach the Mac: put the
runner on the same network, or add a VPN step such as
[Tailscale's GitHub Action](https://github.com/tailscale/github-action) to the job.

Each guide has the details: [agents](docs/guides/agents.md),
[GitHub Actions](docs/guides/github-actions.md), [your app](docs/guides/expo.md),
[recordings](docs/guides/recordings.md), [Android](docs/guides/android.md),
[XCUITest](docs/guides/xcuitest.md).

## Why Devicepool

- **Free and open source.** Apache-2.0. You need no account, Devicepool sends no telemetry, and it
  works offline.
- **One pool for everyone.** Your developers, CI and agents draw from the same devices, and the
  Fleet page shows who has which one and what they are doing on it.
- **A clean device every time.** Devicepool deletes each device after use and clones a fresh one,
  so a test can't inherit a login or a half-finished state from the one before.
- **Builds stay with you.** Your unreleased app and your test accounts stay on your own network.
- **Fast.** On one Mac we measured 52 frames a second in the browser and 87 ms from saving a file
  to seeing the change on the device ([numbers](docs/numbers.md)).

Pick a hosted service if nobody on your team wants to look after a Mac, or if your agents run in
the cloud and can't reach your network.

| | Devicepool | Simlock | Argent | Tapflow | Expo Simulators |
|---|---|---|---|---|---|
| Made for | People, CI and agents | Coding agents | One agent, locally | People in the browser; agents (experimental) | Agents, hosted |
| Use a device in the browser | Yes | Yes, off by default | Not documented | Yes | Yes |
| Sharded CI runs with JUnit | Yes | Not documented | Not documented | Its own flow runner with JUnit (experimental) | Not documented |
| Fast Refresh on a leased device | Yes | Metro tunnel only | Local only | Not documented | Yes |
| Physical phones | Android over USB, experimental: never run on real hardware, use a test phone | Yes | Yes | No | No |
| Runs on | Your Macs | Your machines | Your machine | Your Macs | Expo's servers |

[Full comparison and sources](docs/comparison.md).

## Status

Early, and not on npm yet. It runs on one Mac; more Macs join with `devicepool join`, tested on
one machine so far. A leased iOS app runs as a process on the Mac, so use separate Macs for teams
that do not trust each other's code. Read Apple's macOS license for what running simulators for your
own team allows.

[Features](docs/features.md) · [Alternatives](docs/alternatives/index.md) ·
[Measured speed](docs/numbers.md) ·
[More Macs and Docker](docs/guides/more-macs.md) · [Single sign-on](docs/guides/sso.md) ·
[Design](docs/design.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) · Apache-2.0

Devicepool is not affiliated with Expo.
