# Run Maestro flows from GitHub Actions

`hangar run maestro` splits your flows over fresh simulators, retries a failed flow once on the
same device, marks flows that pass on the retry as flaky, and writes one JUnit report. The CI
runner needs to reach the Hangar Mac (on the same network, or through a VPN such as Tailscale)
and a token in a secret.

1. In the console, make a token for CI on the Connect page and save it as the `HANGAR_TOKEN`
   secret. Save the Mac's address as `HANGAR_URL`.
2. Build a Release simulator app, so the JavaScript is in the app and no Metro is needed. Any
   macOS runner, EAS or Bazel can build it; the example below builds on the runner.

```yaml
name: e2e
on: [pull_request]

jobs:
  maestro:
    runs-on: macos-15
    env:
      HANGAR_URL: ${{ secrets.HANGAR_URL }}
      HANGAR_TOKEN: ${{ secrets.HANGAR_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npx expo prebuild -p ios
      - run: |
          xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release \
            -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath build ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build
      # Hangar is not on npm yet: run its CLI from a clone.
      - run: corepack enable && git clone --depth 1 <hangar repository URL> ../hangar && pnpm --dir ../hangar install
      - run: |
          node ../hangar/packages/cli/src/main.ts run maestro .maestro \
            --app build/Build/Products/Release-iphonesimulator/MyApp.app \
            --shards 3 --retries 1 --junit maestro.xml -e TEST_USER=${{ secrets.TEST_USER }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: maestro, path: maestro.xml }
```

The command exits non-zero when a flow fails after its retry. `config.yaml` in the flows folder
is Maestro's own settings file and is not run as a flow.

Shards wait in Hangar's queue like any lease, so a Mac with three simulators runs three shards
at once and queues the rest.
