# Run Maestro flows from GitHub Actions

The Hangar action splits your flows over fresh simulators, retries a failed flow once on the
same device, marks flows that pass on the retry as flaky, and writes one JUnit report. The CI
runner needs to reach the Hangar Mac (on the same network, or through a VPN such as Tailscale)
and a token in a secret.

1. In the console, make a token for CI on the Connect page and save it as the `HANGAR_TOKEN`
   secret. Save the Mac's address as `HANGAR_URL`. The token needs the install:upload
   permission, because the action uploads the app.
2. Build a Release simulator app, so the JavaScript is in the app and no Metro is needed. Any
   macOS runner, EAS or Bazel can build it; the example below builds on the runner.

```yaml
name: e2e
on: [pull_request]

jobs:
  maestro:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npx expo prebuild -p ios
      - run: |
          xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release \
            -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath build ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build
      - uses: <owner>/hangar@main
        with:
          url: ${{ secrets.HANGAR_URL }}
          token: ${{ secrets.HANGAR_TOKEN }}
          app: build/Build/Products/Release-iphonesimulator/MyApp.app
          flows: .maestro
          shards: 3
          env: |
            TEST_USER=${{ secrets.TEST_USER }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: maestro, path: hangar-maestro.xml }
```

`<owner>/hangar` is wherever your copy of this repository lives on GitHub. The action installs
Node 22 and Hangar's own dependencies, then runs `hangar run maestro`. Its inputs are `url`,
`token`, `app` (a path, or the name of a build already on Hangar), `flows` (default
`.maestro`), `shards`, `retries` (default 1), `model`, `env` (one `KEY=VALUE` per line) and
`junit` (default `hangar-maestro.xml`).

The step fails when a flow fails after its retry. The job's summary page lists the flaky and
failed flows with links to their recordings, and to the run on the console's Runs page, which
shows each flow as it runs. Each retry is recorded: the video, the timeline of Maestro's taps
and the app log of the failing run, kept for 14 days. The JUnit report links the same
recording in a `recording` property on the test case. `config.yaml` in the flows folder is
Maestro's own settings file and is not run as a flow.

Shards wait in Hangar's queue like any lease, so a Mac with three simulators runs three shards
at once and queues the rest. Cancelling the job cancels the run, which releases its devices. If
the runner dies before it can say so, the run goes on in Hangar and releases its devices when it
ends; cancel it on its page.
