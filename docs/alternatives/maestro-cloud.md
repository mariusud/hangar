# Open source alternative to Maestro Cloud

Is there an open source, self-hosted alternative to Maestro Cloud? Yes. Devicepool is an open
source (Apache-2.0) device farm that runs your existing Maestro flows on iOS simulators and
Android emulators on your own Macs, split over several devices, with one JUnit report.

Maestro itself, the CLI and the flow format, is free and open source. Maestro Cloud is the paid
hosted service that runs those flows on devices you don't have to own. Devicepool replaces the
hosted devices and keeps your flows as they are.

## What Maestro Cloud is

Maestro Cloud runs Maestro flows in parallel on hosted Android, iOS and web devices. You upload
an Android ARM APK or an iOS simulator `.app` bundle and a folder of flows:

```bash
maestro cloud --app-file MyApp.app --flows .maestro
```

The pricing page lists Cloud at $250 per device per month. The monthly cost depends on the most
runs you want at the same time. The plan includes unlimited hosted test runs, test reporting, and
CI and pull request integration. An Enterprise plan adds single sign-on and support at a custom
price.

## What Devicepool does instead

- `devicepool run maestro` takes the same folder of flows and the same simulator `.app` or APK.
- `--shards N` leases N fresh devices and gives each a share of the flows, longest first by each
  flow's last timing.
- A failed flow is retried once on the same device (`--retries`, at most 3). A flow that passes
  on a retry is marked flaky.
- The results merge into one JUnit report (`--junit`).
- On iOS simulators, every failed and flaky attempt comes with a link to its video, a timeline of
  actions and the app log.
- Each device is deleted after its shard and replaced with a fresh clone.
- A GitHub Action wraps the same command and comments on the pull request.
- `--hold 30m` keeps the device a flow failed on as the test left it, so a person can open it.
  Held devices are tested against fake hosts only.

The same devices are also open to developers (`devicepool run ios`), to people testing by hand in
the browser, and to AI agents over MCP.

## What Devicepool does not do

- It does not run web tests. Maestro Cloud lists web devices.
- It does not host anything. You need a Mac with Xcode, idb and Maestro installed, and someone
  to keep it updated.
- Your CI runner has to reach that Mac, on the same network or through a VPN.
- It does not run physical phones. They are on the roadmap.
- Retries are not recorded on Android emulators yet.
- It is early and not on npm yet. More than one Mac is tested on one machine so far.
- It has no paid support.

## When to pick Maestro Cloud

- Nobody on your team wants to look after a Mac.
- You want Maestro's own team to run and support the devices.
- Your CI can't reach a machine on your network and you don't want to add a VPN step.
- You run Maestro web flows.

## How to switch

1. On a Mac with Xcode and idb, install Maestro, then start Devicepool:

   ```bash
   git clone https://github.com/mariusud/devicepool && cd devicepool
   pnpm install && npm install -g ./packages/devicepool
   devicepool up
   ```

2. Run the flows you already have. Use a Release simulator build, so the JavaScript is in the
   app and no Metro is needed:

   ```bash
   devicepool run maestro .maestro \
     --app build/Build/Products/Release-iphonesimulator/MyApp.app \
     --shards 3 --junit devicepool-maestro.xml
   ```

3. For CI, run `devicepool connect ci` and paste the two secrets and the step it prints.
   [Run Maestro flows from GitHub Actions](../guides/github-actions.md) has the full workflow.

[Maestro flows](../guides/maestro.md) describes every option.

## Sources

Read on 2026-11-22:

- [maestro.dev/pricing](https://maestro.dev/pricing) for the price and what the Cloud plan
  includes.
- [docs.maestro.dev](https://docs.maestro.dev/cloud/run-maestro-tests-in-the-cloud) for the
  `maestro cloud` command and the app formats.

Devicepool is not affiliated with Maestro or mobile.dev.
