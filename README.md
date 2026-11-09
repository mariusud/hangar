<p align="center"><img src="docs/assets/header.png" alt="Hangar: the open source device broker for React Native teams. A free alternative to Expo Simulators and EAS Maestro jobs, for developers, CI and AI agents." width="100%" /></p>

Hangar is a free, open source device broker. It hands out iOS simulators and Android emulators
from your own Macs to your developers, your CI and your AI agents, and wipes each device when it
comes back. Use it in place of Expo Simulators and EAS Maestro jobs, next to the rest of EAS or
without it. Physical phones are next on the [roadmap](ROADMAP.md).

## What you can use it for

- **Develop on a device you don't have.** Run your app on a leased simulator with
  `hangar run ios`. Fast Refresh, React DevTools and the debugger work as if it were local.
- **Test every pull request.** Maestro flows split over fresh devices, a failed flow retries
  once, and the run writes one JUnit report with a video of each failure. XCUITest and Espresso
  run the same way.
- **Let AI agents check their own work.** Claude Code, Cursor and other MCP clients lease a
  device, tap through the app and read the screen.
- **Try a build by hand.** Open any device in the browser, use it with mouse and keyboard, and
  record a bug as a link to send.

## Start

On the Mac that will hold the devices, such as a Mac mini in the office:

```bash
git clone https://github.com/mariusud/hangar && cd hangar
pnpm install && npm install -g ./packages/hangar
hangar up
```

Open the link it prints to see the devices. Invite your team from the console's People page.

<p align="center"><img src="docs/assets/how-it-works.gif" alt="An AI agent, a CI pipeline and a developer each lease devices from Hangar on two Macs at once; each device is wiped when it comes back" width="100%" /></p>

## Connect

| To use devices from | Run |
|---|---|
| Claude Code | `hangar connect claude` |
| Cursor or another MCP client | `hangar connect cursor` |
| Maestro in CI | `hangar connect ci`, then paste the two secrets and the step it prints |
| Your React Native app, with Fast Refresh | `hangar run ios` or `hangar run android` in your app's folder |
| A test by hand | the console: Use one, then Record for a bug link |
| Your own code | `const device = await hangar.lease()` ([client](docs/guides/agents.md#rest-for-agents-with-their-own-tools)) |

On the Hangar Mac these work right away. From your laptop, install the CLI the same way and run
`hangar login http://your-mac.local:7420` once. CI has to reach the Mac too: run the CI runner on
the same network, or join the job to a VPN with a step such as
[Tailscale's GitHub Action](https://github.com/tailscale/github-action).

Each guide has the details: [agents](docs/guides/agents.md),
[GitHub Actions](docs/guides/github-actions.md), [your app](docs/guides/expo.md),
[recordings](docs/guides/recordings.md), [Android](docs/guides/android.md),
[XCUITest](docs/guides/xcuitest.md).

## Why Hangar

- **Free and open source.** Apache-2.0, with no account, no telemetry and no bill per minute. It
  works without internet.
- **One pool for everyone.** People, CI and agents use the same devices. The Fleet page shows who
  has which device and what they are doing with it.
- **A clean device every time.** Each device is deleted and replaced after use, so nothing leaks
  from one test or person to the next.
- **Builds stay with you.** Unreleased apps and test accounts never leave your network.
- **Fast.** 52 frames a second in the browser, and 87 ms from saving a file to seeing the change on
  the leased device, measured on one Mac ([numbers](docs/numbers.md)).

Hosted is easier when nobody on the team wants to look after a Mac, or when your agents run in
the cloud and cannot reach your network.

| | Hangar | Simlock | Argent | Expo Simulators |
|---|---|---|---|---|
| Made for | People, CI and agents | Coding agents | One agent, locally | Agents, hosted |
| Use a device in the browser | Yes | Watch only | Not documented | Yes |
| Sharded CI runs with JUnit | Yes | Not documented | Not documented | Not documented |
| Fast Refresh on a leased device | Yes | Metro tunnel only | Local only | Yes |
| Physical phones | Not yet | Yes | Yes | No |
| Runs on | Your Macs | Your machines | Your machine | Expo's servers |

[Full comparison and sources](docs/comparison.md).

## Status

Early, and not on npm yet. It runs on one Mac; more Macs join with `hangar join`, tested on one
machine so far. A leased iOS app runs as a process on the Mac, so use separate Macs for teams that
do not trust each other's code. Read Apple's macOS license for what running simulators for your
own team allows.

[Features](docs/features.md) · [Measured speed](docs/numbers.md) ·
[More Macs and Docker](docs/guides/more-macs.md) · [Single sign-on](docs/guides/sso.md) ·
[Design](docs/design.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) · Apache-2.0

Hangar is not affiliated with Expo.
