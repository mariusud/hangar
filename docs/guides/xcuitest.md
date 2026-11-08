# Run XCUITest on leased simulators

`hangar run xcuitest` runs your UI tests the way `hangar run maestro` runs flows: split over fresh
simulators, a failed class retried once on its own and recorded, flaky classes marked, and one
JUnit report.

Build the tests once, on any Mac:

```bash
xcodebuild build-for-testing -workspace ios/MyApp.xcworkspace -scheme MyApp \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build
```

Then run them on Hangar:

```bash
hangar run xcuitest build/Build/Products --shards 3 --junit xcuitest.xml
```

Hangar uploads the `Build/Products` folder (the `.xctestrun` file, the app and the test runner)
as a build, so the token needs the install:upload permission. Each shard runs
`xcodebuild test-without-building` against its leased simulator only, so it cannot touch the
Mac's other devices.

By default the shards split by test target, as the `.xctestrun` lists them. To split finer,
name classes: `--tests AppUITests/LoginTests,AppUITests/HomeTests`. Names are what
`-only-testing` takes: `Target`, `Target/Class` or `Target/Class/testMethod`.

Results come from xcodebuild's output: each test case, its time, and the assertion message of a
failure. The run shows on the console's Runs page like a Maestro run.
