# Open source alternative to Expo Simulators

Is there an open source, self-hosted alternative to Expo Simulators? Yes. Devicepool is an open
source (Apache-2.0) device farm that runs iOS simulators and Android emulators on your own Macs
and lends them to developers, CI and AI agents, with or without the rest of EAS.

## What Expo Simulators is

Expo Simulators runs a remote Android Emulator or iOS Simulator on Expo's infrastructure. You
start and control a session from EAS CLI, a REST API, an AI agent or the browser. Agents drive
the device through agent-device, Argent or Appium. It needs no Mac, so it gives Linux and Windows
users an iOS Simulator. It does not offer physical devices.

```bash
eas simulator:start --platform ios --type agent-device --name "Checkout flow" --non-interactive
eas simulator:stop
```

The documentation calls the `simulator:*` commands experimental. A session lasts at most 115
minutes.

Expo Simulators is available on Expo's paid plans. The pricing page lists $0.10 per minute for
an iOS Simulator and the same for an Android Emulator, with 60 minutes a month included until
2027. The paid plans start at $19 per month.

## What Devicepool does instead

- It runs the simulators and emulators on Macs you own. Your builds and test accounts stay on
  your network, and you need no account anywhere.
- `devicepool run ios` builds your app, leases a simulator and connects it to the Metro on your
  laptop. We measured 87 ms from saving a file to the change on the device
  ([numbers](../numbers.md)). An Expo dev client build opens straight into your bundle.
- React Native DevTools work through the same tunnel: console, breakpoints, network and
  components.
- AI agents connect over MCP at `/mcp`, with mobile-mcp's tool names, or over REST.
  `devicepool connect claude`, `cursor` or `codex` sets one up.
- CI runs Maestro flows split over fresh devices, with retries and one JUnit report, from a
  GitHub Action.
- People open a device in the browser and record a bug as a link.
- A lease has an idle limit and a longest-lease limit that an operator sets. A token made by
  `devicepool connect` allows 30 minutes idle and 8 hours in all.
- Each device is deleted after its lease and replaced with a fresh clone.

## What Devicepool does not do

- It does not work without a Mac. Someone on your team has to own one and keep macOS and Xcode
  updated.
- An agent that runs in someone else's cloud can use it only if it can reach your network.
- It has no Appium endpoint.
- It does not run physical phones. They are on the roadmap.
- It is early and not on npm yet. More than one Mac is tested on one machine so far.

## When to pick Expo Simulators

- Your team works on Linux or Windows and has no Mac to spare.
- Your agents run in the cloud and can't reach your network.
- You already build and ship with EAS and want one account and one bill.
- You already pay for an Expo plan and use a simulator for less than the included 60 minutes a
  month.

## How to switch

1. On a Mac with Xcode and idb:

   ```bash
   git clone https://github.com/mariusud/devicepool && cd devicepool
   pnpm install && npm install -g ./packages/devicepool
   devicepool up
   ```

2. On your laptop, install the CLI the same way, then sign in once and run your app:

   ```bash
   devicepool login http://your-mac.local:7420
   npx expo prebuild -p ios   # Expo apps without an ios folder, once
   devicepool run ios
   ```

3. Give your agent a device in place of `eas simulator:start`:

   ```bash
   devicepool connect claude
   ```

4. For Maestro in CI, run `devicepool connect ci` and paste the two secrets and the step it
   prints.

The guides: [your Expo or React Native app](../guides/expo.md),
[AI agents](../guides/agents.md), [GitHub Actions](../guides/github-actions.md).

## Sources

Read on 2026-11-22:

- [Expo Simulators](https://docs.expo.dev/preview/simulators/) and its
  [get started page](https://docs.expo.dev/preview/simulators/get-started/) for what it is, the
  commands and the session limit.
- [expo.dev/pricing](https://expo.dev/pricing) for prices and included minutes.

Devicepool is not affiliated with Expo.
