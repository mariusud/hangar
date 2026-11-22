# Open source alternative to AWS Device Farm

Is there an open source, self-hosted alternative to AWS Device Farm? For tests that can run on
iOS simulators and Android emulators, yes: Devicepool is an open source (Apache-2.0) device farm
that runs them on your own Macs. For tests that need real phones, no: AWS Device Farm runs
physical devices, and Devicepool does not yet.

## What AWS Device Farm is

AWS Device Farm is an app testing service on real, physical phones and tablets hosted by AWS. It
has two modes:

- Remote access: you use a device in your browser, or point Appium at it from your own machine.
  A session lasts at most 150 minutes.
- Automated testing: you upload your app and tests, and Device Farm runs them on several devices
  in parallel and writes a report with logs, screenshots and video.

The test frameworks its documentation lists are Appium, Android Instrumentation, XCTest and
XCTest UI, plus a built-in fuzz test. The service is available in the `us-west-2` region only.

The pricing page lists $0.17 per device minute, or $250 per device slot per month for unmetered
testing, and private devices from $200 per month. A new account gets a one-time trial of 1,000
device minutes.

## What Devicepool does instead

- It runs iOS simulators and Android emulators on Macs you own, so your unreleased app and your
  test accounts stay on your network.
- It runs Maestro flows, XCUITest and Espresso, split over fresh devices, with retries and one
  JUnit report. XCUITest and Espresso runs are built but haven't run against a real test target
  yet.
- A person can open a device in the browser, click and type on it, and record a bug as a link.
- AI agents use a device over MCP or REST.
- Developers run their React Native app on a leased device with Fast Refresh
  (`devicepool run ios`).
- Each device is deleted after its lease and replaced with a fresh clone.

## What Devicepool does not do

- It does not run physical phones or tablets. They are on the roadmap. A simulator does not
  reproduce a real device's hardware, performance or manufacturer changes.
- It has no Appium endpoint.
- It does not host anything. You need a Mac with Xcode and idb, and someone to keep it updated.
- Your CI runner has to reach that Mac, on the same network or through a VPN.
- It is early and not on npm yet. More than one Mac is tested on one machine so far.

## When to pick AWS Device Farm

- You need to test on real hardware: specific phone models, real performance, cameras, sensors.
- Your tests are written for Appium.
- You want your tests to run inside AWS, next to resources in your VPC.
- Nobody on your team wants to look after a Mac.

The two can run side by side: simulators and emulators on Devicepool for every pull request, and
real devices on Device Farm before a release.

## How to switch the simulator part

1. On a Mac with Xcode and idb:

   ```bash
   git clone https://github.com/mariusud/devicepool && cd devicepool
   pnpm install && npm install -g ./packages/devicepool
   devicepool up
   ```

2. XCTest UI tests: build once with `build-for-testing`, then run the products folder.

   ```bash
   xcodebuild build-for-testing -workspace ios/MyApp.xcworkspace -scheme MyApp \
     -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build
   devicepool run xcuitest build/Build/Products --shards 3 --junit xcuitest.xml
   ```

3. Android instrumentation tests: start Devicepool with an Android virtual device
   (`devicepool up --android <avd>`), then run both APKs.

   ```bash
   ./gradlew assembleDebug assembleDebugAndroidTest
   devicepool run espresso --app app/build/outputs/apk/debug/app-debug.apk \
     --test-apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
     --shards 2 --junit espresso.xml
   ```

4. For a session by hand, open the console link that `devicepool up` prints and use a device.

The guides: [XCUITest](../guides/xcuitest.md), [Android](../guides/android.md),
[Maestro flows](../guides/maestro.md), [recordings](../guides/recordings.md).

## Sources

Read on 2026-11-22:

- [aws.amazon.com/device-farm/pricing](https://aws.amazon.com/device-farm/pricing/) for prices
  and the trial.
- [What is AWS Device Farm?](https://docs.aws.amazon.com/devicefarm/latest/developerguide/welcome.html)
  for what the service is, the region and the session limit.
- [Test frameworks and built-in tests](https://docs.aws.amazon.com/devicefarm/latest/developerguide/test-types.html)
  for the frameworks.

Devicepool is not affiliated with Amazon Web Services.
